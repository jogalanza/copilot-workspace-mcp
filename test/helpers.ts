import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';

/** Create a temp sandbox with a state dir and named workspace folders. */
export function makeSandbox(workspaceNames: string[] = ['alpha', 'beta']) {
  // .native expands Windows 8.3 short names (e.g. JARED~1.GAL), matching fs.promises.realpath used by the server.
  // Spaces on purpose: real deployments live under paths like "D:/Red Files/Projects".
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'copilot mcp test-')));
  const reposDir = path.join(base, 'My Repos');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const workspaces: Record<string, string> = {};
  for (const name of workspaceNames) {
    const dir = path.join(reposDir, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hello.txt'), `hello from ${name}`);
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), `export const name = '${name}';\n`);
    fs.mkdirSync(path.join(dir, 'My Docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'My Docs', 'Read Me.md'), `docs for ${name}`);
    workspaces[name] = dir;
  }
  return {
    base,
    reposDir,
    stateDir,
    dbPath: path.join(stateDir, 'state.db'),
    workspaces,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

export function testConfig(sb: ReturnType<typeof makeSandbox>, overrides: Partial<AppConfig> = {}): AppConfig {
  const config = loadConfig({
    STATE_DB: sb.dbPath,
    ALLOWED_ROOTS: sb.reposDir,
    WORKSPACES: Object.entries(sb.workspaces)
      .map(([alias, p]) => `${alias}=${p}`)
      .join(';'),
    MCP_API_KEY: 'test-key',
    PORT: '1',
  });
  return { ...config, ...overrides };
}
