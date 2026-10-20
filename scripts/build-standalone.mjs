// Builds single-file executables (Node SEA: bundled app + a Node runtime for the target OS/arch).
//   npm run build:standalone                 current OS/arch
//   npm run build:standalone:linux           linux-x64 + linux-arm64
//   npm run build:standalone:mac             darwin-x64 + darwin-arm64
//   npm run build:standalone:all             every target below
//   node scripts/build-standalone.mjs win32-x64 linux-arm64   any mix
// Output: release/copilot-workspace-mcp-<platform>-<arch>[.exe]   (OUT_DIR=... to change)
// Cross-OS targets download that platform's official Node runtime (same version as this one, cached in .cache/node).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { inject } from 'postject';
import { buildShell } from './build-shell.mjs';

const name = 'copilot-workspace-mcp';
const ALL = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const host = `${process.platform}-${process.arch}`;
const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = requested.length ? requested.flatMap((t) => (t === 'all' ? ALL : t === 'linux' ? ['linux-x64', 'linux-arm64'] : t === 'mac' ? ['darwin-x64', 'darwin-arm64'] : [t])) : [host];
for (const t of targets) if (!ALL.includes(t)) throw new Error(`Unknown target "${t}". Use one of: ${ALL.join(', ')}, linux, mac, all`);

const work = 'build-standalone';
const outDir = process.env.OUT_DIR || 'release';
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// Web UI: the Vite + React app in web/ is built to one self-contained index.html (JS, CSS and font inlined),
// which src/uiPage.ts imports as the virtual module "virtual:ui-html".
const uiDir = path.resolve(work, 'ui');
await viteBuild({ configFile: path.resolve('web', 'vite.config.js'), build: { outDir: uiDir, emptyOutDir: true }, logLevel: 'warn' });
const uiHtmlFile = path.join(uiDir, 'index.html');
const inlineUiHtml = {
  name: 'inline-ui-html',
  setup(b) {
    b.onResolve({ filter: /^virtual:ui-html$/ }, () => ({ path: uiHtmlFile }));
    b.onLoad({ filter: /[\\/]ui[\\/]index\.html$/ }, (args) => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'text' }));
  },
};

// playwright-core require()s its own package.json / browsers.json via __dirname, which do not exist inside a single-file binary.
const playwrightPkg = fs.readFileSync('node_modules/playwright-core/package.json', 'utf8');
const playwrightBrowsers = fs.readFileSync('node_modules/playwright-core/browsers.json', 'utf8');
const inlinePlaywrightPackageJson = {
  name: 'inline-playwright-package-json',
  setup(b) {
    b.onLoad({ filter: /playwright-core[\\/]lib[\\/].*\.js$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8');
      const patched = src
        .replace(/require\(import_path\d*\.default\.join\(packageRoot, "package\.json"\)\)/g, () => '(' + playwrightPkg + ')')
        .replace(/require\(import_path\d*\.default\.join\(packageRoot, "browsers\.json"\)\)/g, () => '(' + playwrightBrowsers + ')');
      return { contents: patched, loader: 'js' };
    });
  },
};

// SEA main scripts must be CommonJS, so everything (incl. dependencies) is bundled into one .cjs.
await build({
  entryPoints: ['src/launcher.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: path.join(work, 'launcher.cjs'),
  plugins: [inlineUiHtml, inlinePlaywrightPackageJson],
  logLevel: 'warning',
  legalComments: 'none',
  // Only needed by playwright's Firefox/BiDi path; this app drives Chromium over CDP.
  external: ['chromium-bidi/*', 'electron'],
});

// Windows executables also carry the frameless WebView2 host, extracted on first run. It can only be built on
// Windows with the .NET SDK; otherwise the launcher falls back to a browser app window. Other OSes ignore the assets.
const shell = targets.some((t) => t.startsWith('win32')) ? buildShell() : undefined;
const assets = shell ? Object.fromEntries(shell.files.map((f) => [`shell/${f}`, path.join(shell.dir, f)])) : undefined;

// The blob contains no code cache/snapshot, so one blob works for every platform (it must match this Node's version).
fs.writeFileSync(
  path.join(work, 'sea-config.json'),
  JSON.stringify({ main: path.join(work, 'launcher.cjs'), output: path.join(work, 'app.blob'), disableExperimentalSEAWarning: true, ...(assets ? { assets } : {}) }),
);
execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea-config.json')], { stdio: 'inherit' });
const blob = fs.readFileSync(path.join(work, 'app.blob'));

/** The Node binary to embed the app into: this one for the host target, otherwise the official download (cached). */
async function nodeBinaryFor(target) {
  if (target === host) return process.execPath;
  const [plat, arch] = target.split('-');
  const ver = process.version; // e.g. v24.21.0
  const cacheDir = path.resolve('.cache', 'node', `${ver}-${target}`);
  const bin = path.join(cacheDir, plat === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(cacheDir, { recursive: true });
  const download = async (url) => {
    console.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    return Buffer.from(await res.arrayBuffer());
  };
  if (plat === 'win32') {
    fs.writeFileSync(bin, await download(`https://nodejs.org/dist/${ver}/win-${arch}/node.exe`));
    return bin;
  }
  const base = `node-${ver}-${plat}-${arch}`;
  fs.writeFileSync(path.join(cacheDir, 'node.tar.gz'), await download(`https://nodejs.org/dist/${ver}/${base}.tar.gz`));
  // Relative paths + cwd: GNU tar (Git for Windows) treats "C:\..." as a remote host.
  execFileSync('tar', ['-xzf', 'node.tar.gz', '--strip-components=2', `${base}/bin/node`], { cwd: cacheDir, stdio: 'inherit' });
  fs.rmSync(path.join(cacheDir, 'node.tar.gz'));
  return bin;
}

for (const target of targets) {
  const [plat] = target.split('-');
  const out = path.join(outDir, `${name}-${target}${plat === 'win32' ? '.exe' : ''}`);
  const src = await nodeBinaryFor(target);
  fs.copyFileSync(src, out);
  const mac = plat === 'darwin';
  const canSign = mac && process.platform === 'darwin';
  if (canSign) execFileSync('codesign', ['--remove-signature', out]);
  await inject(out, 'NODE_SEA_BLOB', blob, {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    machoSegmentName: mac ? 'NODE_SEA' : undefined,
  });
  if (canSign) execFileSync('codesign', ['--sign', '-', out]);
  if (plat !== 'win32') fs.chmodSync(out, 0o755);
  console.log(`Built ${out} (${(fs.statSync(out).size / 1048576).toFixed(0)} MB)`);
  if (mac && !canSign) console.log(`  note: on the Mac run once:  codesign --sign - ${path.basename(out)} && xattr -d com.apple.quarantine ${path.basename(out)}`);
}
fs.rmSync(work, { recursive: true, force: true });
