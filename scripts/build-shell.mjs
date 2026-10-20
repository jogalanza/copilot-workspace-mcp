// Builds the frameless WebView2 host (shell/) into build-shell/. Windows only: needs the .NET SDK, which is
// optional - without it the standalone is built without the shell and falls back to a browser app window.
//   npm run build:shell
// Imported by build-standalone.mjs, which embeds the files into the executable.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHELL_OUT = path.join(root, 'build-shell');

/** Files the host needs at runtime (everything else the build emits is dropped). */
const KEEP = ['CopilotShell.exe', 'CopilotShell.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];

/**
 * Returns { dir, files, id } for the built host, or undefined when it cannot be built here.
 * `id` changes whenever the content does; the launcher extracts into a folder named after it.
 */
export function buildShell() {
  if (process.platform !== 'win32') return undefined;
  const r = spawnSync('dotnet', ['build', path.join(root, 'shell', 'CopilotShell.csproj'), '-c', 'Release', '-o', SHELL_OUT, '--nologo', '-v', 'q'], {
    encoding: 'utf8',
    shell: false,
  });
  if (r.error || r.status !== 0) {
    const why = r.error ? 'the .NET SDK was not found' : `dotnet build failed:\n${(r.stdout || '') + (r.stderr || '')}`;
    console.warn(`Skipping the frameless shell: ${why}`);
    return undefined;
  }
  for (const f of fs.readdirSync(SHELL_OUT)) if (!KEEP.includes(f)) fs.rmSync(path.join(SHELL_OUT, f), { recursive: true, force: true });
  const hash = crypto.createHash('sha256');
  for (const f of KEEP) hash.update(f).update(fs.readFileSync(path.join(SHELL_OUT, f)));
  const id = hash.digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(SHELL_OUT, 'manifest.json'), JSON.stringify({ id, files: KEEP }));
  console.log(`Built the frameless shell (${KEEP.length} files, id ${id}).`);
  return { dir: SHELL_OUT, files: [...KEEP, 'manifest.json'], id };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!buildShell()) process.exitCode = 1;
}
