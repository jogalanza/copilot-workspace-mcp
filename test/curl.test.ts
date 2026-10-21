import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { curl, type CurlMethod } from '../src/curlTool.js';

describe('curl tool', () => {
  let server: http.Server;
  let base: string;
  const allowed = ['localhost', '127.0.0.1'];
  const call = (path: string, method: CurlMethod = 'GET', extra: Partial<Parameters<typeof curl>[0]> = {}) =>
    curl({ url: `${base}${path}`, method, timeoutMs: 5000, allowedHosts: allowed, followRedirects: false, ...extra });

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') return void res.writeHead(302, { location: '/echo' }).end();
      if (req.url === '/evil') return void res.writeHead(302, { location: 'http://example.com/' }).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => void server.close());

  it('sends each method with headers and a body', async () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const out = await call('/echo', m, { body: 'hello', headers: { Authorization: 'Bearer t' } });
      assert.match(out, /HTTP 200/);
      assert.match(out, new RegExp(`"method": "${m}"`));
      assert.match(out, /"body": "hello"/);
      assert.match(out, /"auth": "Bearer t"/);
    }
    assert.match(await call('/echo', 'HEAD'), /HTTP 200/);
  });

  it('refuses a body on GET and hosts that are not allowed', async () => {
    await assert.rejects(call('/echo', 'GET', { body: 'x' }), /cannot have a body/);
    await assert.rejects(curl({ url: 'http://example.com/', method: 'GET', timeoutMs: 1000, allowedHosts: allowed, followRedirects: false }), /not allowed/);
    await assert.rejects(call('/echo', 'GET', { headers: { Host: 'evil' } }), /cannot be set/);
  });

  it('does not follow redirects by default, and re-checks the host on each hop', async () => {
    assert.match(await call('/redirect'), /HTTP 302/);
    assert.match(await call('/redirect', 'GET', { followRedirects: true }), /"method": "GET"/);
    await assert.rejects(call('/evil', 'GET', { followRedirects: true }), /not allowed/);
  });
});

describe('curl tool: self-signed https', () => {
  let server: https.Server;
  let url: string;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'curl-tls-'));
    writeFileSync(join(dir, 'o.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n');
    execFileSync('openssl', ['req', '-config', join(dir, 'o.cnf'), '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', 
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    server = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('secure ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `https://localhost:${(server.address() as AddressInfo).port}/`;
  });
  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = { url: '', method: 'GET' as const, timeoutMs: 5000, allowedHosts: ['localhost'], followRedirects: false };

  it('fails with a hint by default and succeeds with insecureTls on localhost', async () => {
    await assert.rejects(curl({ ...opts, url }), /insecureTls=true/);
    assert.match(await curl({ ...opts, url, insecureTls: true }), /HTTP 200[\s\S]*secure ok/);
  });
});
