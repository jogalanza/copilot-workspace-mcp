// Packages the executables found in release/ into download-ready archives:
//   release/packages/copilot-workspace-mcp-v<ver>-<windows|macos|linux>-<x64|arm64>.<zip|tar.gz>  + SHA256SUMS.txt
// Each archive holds one folder with the executable, a short README.txt and the LICENSE.
// Archives are written in pure Node so the executable bit (755) survives even when packaging on Windows.
//   npm run package        build every target, then package   (see package.json)
//   node scripts/package-release.mjs   package whatever is already in release/ (used by CI)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const NAME = 'copilot-workspace-mcp';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const inDir = process.env.OUT_DIR || 'release';
const outDir = path.join(inDir, 'packages');
const OS_LABEL = { win32: 'windows', darwin: 'macos', linux: 'linux' };

const QUICKSTART = {
  windows: `1. Double-click ${NAME}.exe (or run it from PowerShell).
   Windows SmartScreen may warn because the app is not code-signed: click "More info" > "Run anyway".`,
  macos: `1. In Terminal, from this folder, run once:
     xattr -d com.apple.quarantine ./${NAME} ; chmod +x ./${NAME}
   (If macOS reports a damaged app or killed process, also run: codesign --sign - ./${NAME})
2. Start it:  ./${NAME}`,
  linux: `1. In a terminal, from this folder:  chmod +x ./${NAME} && ./${NAME}`,
};

const readme = (os) => `Copilot Workspace MCP v${version}
================================

Lets Microsoft 365 Copilot / Copilot Studio read and write files in folders you choose,
through a Microsoft dev tunnel. No install, no build.

Start
-----
${QUICKSTART[os]}

First run
---------
- Asks which folder to expose (default: the folder you started it from) and generates an API key.
- Downloads the Microsoft "devtunnel" CLI if you do not have it, and asks you to sign in.
- Creates a persistent tunnel and prints the public https://.../mcp URL plus your API key.
- Opens a control window (live logs, settings, restart/stop). Use --no-open to skip it.

In Copilot Studio add an MCP tool with that URL and authentication "API key",
type Header, name  api-key, value = the key.

Useful options:  --help  --show-key  --reconfigure  --new-key  --no-tunnel  --no-ui  --no-open  --verbose
Config is stored per user (Windows: %APPDATA%\\${NAME}, others: ~/.config/${NAME}).
Stop with Ctrl+C or the Stop button.

Docs: https://github.com/jogalanza/copilot-workspace-mcp  (README.md)
Licensed under MIT (see LICENSE).
`;

// ---- minimal archive writers ---------------------------------------------------------------

function tarEntry(name, data, mode) {
  const h = Buffer.alloc(512);
  const put = (s, off, len) => h.write(s, off, len, 'ascii');
  const oct = (n, len) => (n.toString(8).padStart(len - 1, '0') + '\0');
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(data.length, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder (spaces)
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const sum = h.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

function writeTarGz(file, entries) {
  const body = Buffer.concat([...entries.map((e) => tarEntry(e.name, e.data, e.mode)), Buffer.alloc(1024)]);
  fs.writeFileSync(file, zlib.gzipSync(body, { level: 9 }));
}

function writeZip(file, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const comp = zlib.deflateRawSync(e.data, { level: 9 });
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made by: UNIX
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, central, end]));
}

// ---- main ----------------------------------------------------------------------------------

const pattern = new RegExp(`^${NAME}-(win32|darwin|linux)-(x64|arm64)(\\.exe)?$`);
const binaries = fs.existsSync(inDir) ? fs.readdirSync(inDir).filter((f) => pattern.test(f)) : [];
if (!binaries.length) throw new Error(`No ${NAME}-<platform>-<arch> executables in ${inDir}/. Run "npm run build:standalone[:all]" first.`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const license = fs.existsSync('LICENSE') ? fs.readFileSync('LICENSE') : Buffer.from('MIT\n');
const sums = [];

for (const file of binaries.sort()) {
  const [, plat, arch] = pattern.exec(file);
  const os = OS_LABEL[plat];
  const folder = `${NAME}-v${version}-${os}-${arch}`;
  const exeName = plat === 'win32' ? `${NAME}.exe` : NAME;
  const entries = [
    { name: `${folder}/${exeName}`, data: fs.readFileSync(path.join(inDir, file)), mode: 0o755 },
    { name: `${folder}/README.txt`, data: Buffer.from(readme(os)), mode: 0o644 },
    { name: `${folder}/LICENSE`, data: license, mode: 0o644 },
  ];
  const archive = path.join(outDir, `${folder}.${plat === 'win32' ? 'zip' : 'tar.gz'}`);
  (plat === 'win32' ? writeZip : writeTarGz)(archive, entries);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  sums.push(`${sha}  ${path.basename(archive)}`);
  console.log(`Packaged ${archive} (${(fs.statSync(archive).size / 1048576).toFixed(0)} MB)`);
}
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
