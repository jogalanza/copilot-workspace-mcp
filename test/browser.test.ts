import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { assertUrlAllowed, BrowserManager, isHostAllowed, loopbackVariants } from '../src/browserManager.js';
import type { AppConfig } from '../src/config.js';
import { StateStore } from '../src/db.js';
import { parseCommand, ProcessManager } from '../src/processManager.js';
import { WorkspaceService } from '../src/workspaceManager.js';
import { makeSandbox, testConfig } from './helpers.js';

describe('browser URL allowlist', () => {
  const allowed = ['localhost', '127.0.0.1', '*.example.com'];
  it('matches exact hosts and wildcard subdomains only', () => {
    assert.equal(isHostAllowed('localhost', allowed), true);
    assert.equal(isHostAllowed('LOCALHOST', allowed), true);
    assert.equal(isHostAllowed('a.example.com', allowed), true);
    assert.equal(isHostAllowed('example.com', allowed), false);
    assert.equal(isHostAllowed('evilexample.com', allowed), false);
    assert.equal(isHostAllowed('localhost.evil.com', allowed), false);
  });
  it('rejects non-http schemes and other hosts', () => {
    assert.doesNotThrow(() => assertUrlAllowed('http://localhost:5173/x', allowed));
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://169.254.169.254/', 'http://localhost@evil.com/', 'nonsense']) {
      assert.throws(() => assertUrlAllowed(bad, allowed), `should reject ${bad}`);
    }
  });
});

describe('run_command allowlist', () => {
  const allowed = ['npm run dev', 'npm test'];
  it('accepts allowlisted prefixes with plain extra arguments', () => {
    assert.deepEqual(parseCommand('npm test', allowed), ['npm', 'test']);
    assert.deepEqual(parseCommand('npm  run dev -- --port 5173', allowed), ['npm', 'run', 'dev', '--', '--port', '5173']);
    assert.deepEqual(parseCommand('NPM TEST', allowed), ['NPM', 'TEST']);
  });
  it('rejects other commands, shell operators and quoting', () => {
    for (const bad of [
      'rm -rf /',
      'npm install',
      'npm test && calc',
      'npm test | more',
      'npm test; calc',
      'npm test > out.txt',
      'npm test $(calc)',
      'npm test `calc`',
      'npm test "a b"',
      'npm test %PATH%',
      'npm test\ncalc',
      '',
    ]) {
      assert.throws(() => parseCommand(bad, allowed), `should reject ${JSON.stringify(bad)}`);
    }
  });
  it('is disabled with an empty allowlist', () => {
    assert.throws(() => parseCommand('npm test', []), /disabled/);
  });
});

async function canLaunchBrowser(config: AppConfig) {
  const bm = new BrowserManager(config);
  try {
    await bm.session('probe');
    return true;
  } catch {
    return false;
  } finally {
    await bm.shutdown();
  }
}

describe('run_command + browser tools over MCP', async () => {
  const sb = makeSandbox(['site']);
  const SERVER_JS = `
import http from 'node:http';
const s = http.createServer((req, res) => {
  if (req.url === '/broken.js') { res.statusCode = 404; return res.end('no'); }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>Test App</title><h1 id="h">Hello browser</h1><button onclick="document.getElementById(\\'h\\').textContent=\\'Clicked!\\'">Go</button><input id="q"><script src="/broken.js"></script><img src="http://169.254.169.254/x.png">');
});
s.listen(0, '127.0.0.1', () => console.log('READY http://127.0.0.1:' + s.address().port + '/'));
`;
  fs.writeFileSync(path.join(sb.workspaces.site, 'server.mjs'), SERVER_JS);
  const config = testConfig(sb, {
    enableBrowser: true,
    runAllowedCommands: ['node server.mjs', 'node --version'],
    runTimeoutSeconds: 20,
  });
  const browserOk = await canLaunchBrowser(config);

  const store = new StateStore(config.stateDbPath);
  const workspaces = new WorkspaceService(store, config);
  await workspaces.seed();
  const browser = new BrowserManager(config);
  const processes = new ProcessManager(config);
  const app = createApp({ config, store, workspaces, browser, processes });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const connect = async (conv: string) => {
    const c = new Client({ name: 'e2e', version: '1.0.0' });
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { 'api-key': 'test-key', 'conversation-id': conv } },
      }),
    );
    return c;
  };
  type Content = { type: string; text?: string; data?: string; mimeType?: string };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as { content: Content[]; isError?: boolean };
    return {
      text: r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n'),
      images: r.content.filter((x) => x.type === 'image'),
      isError: !!r.isError,
    };
  };

  after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await processes.shutdown();
    await browser.shutdown();
    store.close();
    sb.cleanup();
  });

  it('runs allowlisted foreground commands and refuses others', async () => {
    const c = await connect('conv-1');
    const ok = await call(c, 'run_command', { command: 'node --version' });
    assert.equal(ok.isError, false);
    assert.match(ok.text, /exited \(code 0\)/);
    assert.match(ok.text, /v\d+\./);
    const bad = await call(c, 'run_command', { command: 'node -e process.exit(1)' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not allowed|not allowed/i);
    const chained = await call(c, 'run_command', { command: 'node --version && calc' });
    assert.equal(chained.isError, true);
    await c.close();
  });

  it('process_wait returns on readiness text, times out while running, and reports exit', async () => {
    const c = await connect('conv-wait');
    try {
      const started = await call(c, 'run_command', { command: 'node server.mjs', background: true, timeoutSeconds: 1, readyText: 'NEVER-PRINTED' });
      const id = /process ([0-9a-f]{6}) \[running\]/.exec(started.text)?.[1];
      assert.ok(id, started.text);
      const ready = await call(c, 'process_wait', { id, untilText: 'READY', timeoutSeconds: 10 });
      assert.match(ready.text, /^"READY" appeared/);
      const slow = await call(c, 'process_wait', { id, untilText: 'NEVER-PRINTED', timeoutSeconds: 1 });
      assert.match(slow.text, /^still running after 1s/);
      await call(c, 'process_stop', { id });
      assert.match((await call(c, 'process_wait', { id, timeoutSeconds: 5 })).text, /^process exited/);
      assert.equal((await call(c, 'process_wait', { id: 'ffffff' })).isError, true);
    } finally {
      await c.close();
    }
  });

  it('keeps processes private to the chat that started them', async () => {
    const a = await connect('conv-A');
    const b = await connect('conv-B');
    try {
      const started = await call(a, 'run_command', { command: 'node server.mjs', background: true, readyText: 'READY' });
      assert.match(started.text, /\(ready\)/);
      const id = /process ([0-9a-f]{6}) \[running\]/.exec(started.text)?.[1];
      assert.ok(id, started.text);
      assert.match((await call(a, 'list_processes')).text, new RegExp(id));
      assert.equal((await call(b, 'list_processes')).text, '(no processes)');
      assert.equal((await call(b, 'process_stop', { id })).isError, true);
      const stopped = await call(a, 'process_stop', { id });
      assert.match(stopped.text, /exited/);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('asks for user approval before running a command that is not on the allowlist', async () => {
    const c = await connect('conv-approve');
    try {
      const refused = await call(c, 'run_command', { command: 'node -v' });
      assert.equal(refused.isError, true);
      assert.match(refused.text, /ask the user in chat to approve this exact command: "node -v"[\s\S]*userApproved=true/);
      const approved = await call(c, 'run_command', { command: 'node -v', userApproved: true });
      assert.equal(approved.isError, false, approved.text);
      assert.match(approved.text, /exited \(code 0\)/);
      // Approval waives only the allowlist, never the shell-operator rules.
      const chained = await call(c, 'run_command', { command: 'node -v && calc', userApproved: true });
      assert.equal(chained.isError, true);
      assert.match(chained.text, /characters that are not allowed/);
    } finally {
      await c.close();
    }
  });

  it('browser_open retries other loopback addresses and explains a closed port', { skip: !browserOk && 'no Edge/Chrome available' }, async () => {
    const v6 = http.createServer((_q, r) => r.setHeader('content-type', 'text/html').end('<title>v6 app</title>hi'));
    const bound = await new Promise<boolean>((resolve) => {
      v6.once('error', () => resolve(false));
      v6.listen(0, '::1', () => resolve(true));
    });
    const c = await connect('conv-loopback');
    try {
      if (bound) {
        const port = (v6.address() as AddressInfo).port;
        const opened = await call(c, 'browser_open', { url: `http://127.0.0.1:${port}/` });
        assert.equal(opened.isError, false, opened.text);
        assert.match(opened.text, /title: v6 app/);
        assert.match(opened.text, /127\.0\.0\.1:\d+ refused the connection, but (localhost|\[::1\]):\d+ answered/);
      }
      const free = http.createServer();
      await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
      const closedPort = (free.address() as AddressInfo).port;
      await new Promise((r) => free.close(r));
      const closed = await call(c, 'browser_open', { url: `http://localhost:${closedPort}/` });
      assert.equal(closed.isError, true);
      assert.match(closed.text, /Connection refused at http:\/\/localhost:\d+: nothing is listening[\s\S]*run_command with background=true/);
    } finally {
      await c.close();
      v6.close();
    }
  });

  it('loopbackVariants lists the other loopback spellings only for loopback hosts', () => {
    assert.deepEqual(loopbackVariants(new URL('http://127.0.0.1:5000/a')).map((u) => u.host), ['localhost:5000', '[::1]:5000']);
    assert.deepEqual(loopbackVariants(new URL('http://[::1]:5000/')).map((u) => u.host), ['localhost:5000', '127.0.0.1:5000']);
    assert.deepEqual(loopbackVariants(new URL('https://example.com/')), []);
  });

  it('opens a local page, screenshots it, reads text, clicks, and blocks external hosts', { skip: !browserOk && 'no Edge/Chrome available' }, async () => {
    const c = await connect('conv-web');
    try {
      const started = await call(c, 'run_command', { command: 'node server.mjs', background: true, readyText: 'READY' });
      const pageUrl = /READY (http:\/\/127\.0\.0\.1:\d+\/)/.exec(started.text)?.[1];
      assert.ok(pageUrl, started.text);

      const opened = await call(c, 'browser_open', { url: pageUrl });
      assert.equal(opened.isError, false, opened.text);
      assert.match(opened.text, /title: Test App/);

      const shot = await call(c, 'browser_screenshot');
      assert.equal(shot.isError, false, shot.text);
      assert.equal(shot.images.length, 1);
      assert.equal(shot.images[0].mimeType, 'image/png');
      assert.equal(Buffer.from(shot.images[0].data!, 'base64').subarray(1, 4).toString(), 'PNG');
      const saved = /saved to (\.screenshots\/[^ ]+\.png)/.exec(shot.text)?.[1];
      assert.ok(saved && fs.existsSync(path.join(sb.workspaces.site, saved)), shot.text);

      assert.match((await call(c, 'browser_text', { selector: '#h' })).text, /Hello browser/);
      await call(c, 'browser_click', { selector: 'text=Go' });
      assert.match((await call(c, 'browser_text', { selector: '#h' })).text, /Clicked!/);
      await call(c, 'browser_type', { selector: '#q', text: 'abc' });

      assert.equal((await call(c, 'browser_eval', { expression: 'document.title' })).text, '"Test App"');
      assert.equal(
        (await call(c, 'browser_eval', { expression: '(async () => { await 0; return [1, 2].length * 2; })()' })).text,
        '4',
      );
      assert.equal((await call(c, 'browser_eval', { expression: 'undefined' })).text, 'undefined');
      const thrown = await call(c, 'browser_eval', { expression: 'nope.nope' });
      assert.equal(thrown.isError, true);
      // Page scripts are subject to the same host allowlist as the page itself.
      const leak = await call(c, 'browser_eval', { expression: "fetch('http://169.254.169.254/').then(() => 'reached', () => 'blocked')" });
      assert.equal(leak.text, '"blocked"');

      const logs = (await call(c, 'browser_logs')).text;
      assert.match(logs, /http 404.*broken\.js/);
      assert.match(logs, /\[blocked\] http:\/\/169\.254\.169\.254/);

      const external = await call(c, 'browser_open', { url: 'http://example.com/' });
      assert.equal(external.isError, true);
      assert.match(external.text, /not allowed/);
      const fileUrl = await call(c, 'browser_open', { url: 'file:///C:/Windows/win.ini' });
      assert.equal(fileUrl.isError, true);

      assert.match((await call(c, 'browser_close')).text, /closed/);
      const noPage = await call(c, 'browser_screenshot');
      assert.equal(noPage.isError, true);
      assert.match(noPage.text, /browser_open first/);
    } finally {
      await call(c, 'list_processes').then(async (l) => {
        for (const id of l.text.match(/^[0-9a-f]{6}/gm) ?? []) await call(c, 'process_stop', { id });
      });
      await c.close();
    }
  });
});
