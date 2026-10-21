import https from 'node:https';
import { assertUrlAllowed } from './browserManager.js';
import { AccessError } from './security.js';

export const CURL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type CurlMethod = (typeof CURL_METHODS)[number];

const MAX_BODY_CHARS = 100_000;
const MAX_REDIRECTS = 5;
/** Headers the caller may not set: hop-by-hop / framing headers that fetch manages itself. */
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade']);

export interface CurlOptions {
  url: string;
  method: CurlMethod;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  allowedHosts: string[];
  followRedirects: boolean;
  /** Skip TLS verification. Honoured only for loopback hosts (dev certificates such as `dotnet dev-certs`). */
  insecureTls?: boolean;
}

const isLoopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());

/** fetch() without certificate verification, via node:https; used only for loopback dev servers. */
function insecureFetch(url: URL, init: { method: string; headers: Headers; body?: string; signal: AbortSignal }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: init.method, headers: Object.fromEntries(init.headers), rejectUnauthorized: false, signal: init.signal },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) h.append(k, x);
          const status = res.statusCode ?? 0;
          const nullBody = status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
          resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage, headers: h }));
        });
        res.on('error', reject);
      },
    );
    req.on('error', (e) => reject(Object.assign(new Error(e.message), { cause: e })));
    req.end(init.body);
  });
}

const clip = (s: string) => (s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS)}\n[truncated: ${s.length} chars]` : s);

/**
 * Send one HTTP request and format status, headers and body like `curl -i`. Only http(s) URLs on allowed
 * hosts are contacted, and every redirect hop is re-checked against the allowlist, so a redirect cannot
 * be used to reach a host the admin did not allow (SSRF).
 */
export async function curl(opts: CurlOptions): Promise<string> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (BLOCKED_HEADERS.has(k.toLowerCase())) throw new AccessError(`Header "${k}" cannot be set.`);
    headers.set(k, v);
  }
  if (opts.body !== undefined && (opts.method === 'GET' || opts.method === 'HEAD')) {
    throw new AccessError(`${opts.method} requests cannot have a body.`);
  }

  let url = assertUrlAllowed(opts.url, opts.allowedHosts);
  let method: string = opts.method;
  let body = opts.body;
  const started = Date.now();
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const hops: string[] = [];

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res =
        opts.insecureTls && url.protocol === 'https:' && isLoopback(url.hostname)
          ? await insecureFetch(url, { method, headers, body, signal })
          : await fetch(url, { method, headers, body, redirect: 'manual', signal });
    } catch (err) {
      if (signal.aborted) throw new Error(`Request timed out after ${Math.round(opts.timeoutMs / 1000)}s.`);
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      const msg = cause?.message ?? cause?.code ?? (err as Error).message;
      const hint = /self-signed|certificate|CERT_/i.test(msg) ? ' For a local dev server with a self-signed certificate, call curl again with insecureTls=true (works for localhost only), or use its http:// URL.' : '';
      throw new Error(`Request failed: ${msg}.${hint}`);
    }

    const location = res.headers.get('location');
    if (opts.followRedirects && location && res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) throw new Error(`Stopped after ${MAX_REDIRECTS} redirects.`);
      await res.body?.cancel();
      url = assertUrlAllowed(new URL(location, url).href, opts.allowedHosts);
      hops.push(`${res.status} -> ${url.href}`);
      // 301/302/303 turn a non-GET/HEAD into GET without a body, as curl and browsers do.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
      }
      continue;
    }

    const raw = await res.text();
    const type = res.headers.get('content-type') ?? '';
    let payload = raw;
    if (/json/i.test(type)) {
      try {
        payload = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        /* not valid JSON: show as received */
      }
    }
    const head = [`HTTP ${res.status} ${res.statusText}`.trim(), ...[...res.headers].map(([k, v]) => `${k}: ${v}`)];
    const redirects = hops.length ? `redirects: ${hops.join(', ')}\n` : '';
    return `${method} ${url.href}\n${redirects}time: ${Date.now() - started} ms, ${raw.length} chars\n\n${head.join('\n')}\n\n${clip(payload) || '(empty body)'}`;
  }
}
