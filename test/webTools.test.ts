import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { assertPublicUrl, htmlToText, isPrivateAddress, webFetch, webSearch } from '../src/webTools.js';

describe('isPrivateAddress', () => {
  it('flags local and private ranges, not public ones', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });
});

describe('assertPublicUrl', () => {
  it('blocks private hosts unless trusted, and bad schemes or credentials', async () => {
    await assert.rejects(assertPublicUrl('http://127.0.0.1:8080/'), /private or local/);
    await assert.rejects(assertPublicUrl('http://[::1]/'), /private or local/);
    await assert.rejects(assertPublicUrl('http://localhost/'), /private or local/);
    await assert.rejects(assertPublicUrl('file:///etc/passwd'), /Only http/);
    await assert.rejects(assertPublicUrl('http://user:pw@8.8.8.8/'), /credentials/);
    assert.equal((await assertPublicUrl('http://127.0.0.1:8080/', ['127.0.0.1'])).port, '8080');
    assert.equal((await assertPublicUrl('http://8.8.8.8/')).hostname, '8.8.8.8');
  });
});

describe('htmlToText', () => {
  it('keeps structure and drops scripts', () => {
    const { title, text } = htmlToText(
      '<html><head><title>My &amp; Page</title><style>p{}</style></head><body><script>alert(1)</script><h1>Head</h1><p>Hi <a href="/x">link</a></p><ul><li>one</li><li>two</li></ul><pre>a  b\nc</pre> &lt;ok&gt; &#65;</body></html>',
    );
    assert.equal(title, 'My & Page');
    assert.match(text, /# Head/);
    assert.match(text, /Hi \[link\]\(\/x\)/);
    assert.match(text, /- one\n- two/);
    assert.match(text, /```\na {2}b\nc\n```/);
    assert.match(text, /<ok> A/);
    assert.doesNotMatch(text, /alert|p\{\}/);
  });
});

describe('webFetch and webSearch', () => {
  let server: http.Server;
  let base: string;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/page') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<title>T</title><h2>Hello</h2><p>world</p>');
      if (req.url === '/json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1}');
      if (req.url === '/bin') return void res.writeHead(200, { 'content-type': 'image/png' }).end('x');
      if (req.url === '/hop') return void res.writeHead(302, { location: 'http://10.0.0.1/' }).end();
      if (req.url === '/long') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('0123456789');
      if (req.url?.startsWith('/search')) {
        const ok = req.headers['x-subscription-token'] === 'k';
        return void res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' }).end(
          JSON.stringify({ web: { results: [{ title: 'A <b>one</b>', url: 'https://a.test/', description: 'desc &amp; more' }] } }),
        );
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => void server.close());
  const fetchPage = (p: string, extra = {}) => webFetch({ url: base + p, timeoutMs: 5000, trustedHosts: ['127.0.0.1'], ...extra });

  it('converts HTML, pretty-prints JSON, pages long bodies and refuses binary types', async () => {
    const page = await fetchPage('/page');
    assert.match(page, /HTTP 200[\s\S]*title: T[\s\S]*## Hello\n\nworld/);
    assert.match(await fetchPage('/json'), /"a": 1/);
    assert.match(await fetchPage('/long', { maxChars: 4 }), /0123\n\[showing chars 0-4 of 10; use offset=4/);
    assert.match(await fetchPage('/long', { offset: 8 }), /\n\n89$/);
    await assert.rejects(fetchPage('/bin'), /Unsupported content type/);
  });

  it('refuses private hosts that are not trusted, including via redirect', async () => {
    await assert.rejects(webFetch({ url: `${base}/page`, timeoutMs: 5000, trustedHosts: [] }), /private or local/);
    await assert.rejects(fetchPage('/hop'), /private or local/);
  });

  it('formats search results and reports a bad key', async () => {
    const out = await webSearch({ query: 'x', endpoint: `${base}/search`, apiKey: 'k', count: 5, timeoutMs: 5000 });
    assert.equal(out, '1. A one\n   https://a.test/\n   desc & more');
    await assert.rejects(webSearch({ query: ' ', endpoint: `${base}/search`, apiKey: 'k', count: 5, timeoutMs: 5000 }), /query is required/);
    await assert.rejects(webSearch({ query: 'x', endpoint: `${base}/search`, apiKey: 'bad', count: 5, timeoutMs: 5000 }), /HTTP 401/);
  });
});
