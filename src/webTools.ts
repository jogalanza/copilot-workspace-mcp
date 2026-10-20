import dns from 'node:dns/promises';
import net from 'node:net';
import { AccessError } from './security.js';

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 50_000;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.match(/^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p;
}

/**
 * Check a URL before contacting it: http(s) only, no embedded credentials, and the host must resolve to a
 * public address. Hosts the admin listed in `trustedHosts` skip the address check (e.g. an internal wiki).
 * Resolution happens here and again inside fetch, so a DNS-rebinding host could still slip through.
 */
export async function assertPublicUrl(raw: string, trustedHosts: string[] = []): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AccessError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AccessError(`Only http(s) URLs are allowed (got "${url.protocol}").`);
  }
  if (url.username || url.password) throw new AccessError('URLs with embedded credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (trustedHosts.some((p) => hostMatches(host, p))) return url;
  const addrs = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new AccessError(`Could not resolve host "${host}".`);
  if (addrs.some(isPrivateAddress)) {
    throw new AccessError(
      `Host "${host}" is a private or local address. The server admin can list it in WEB_ALLOWED_HOSTS to allow it.`,
    );
  }
  return url;
}

// ---- HTML -> readable text -----------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', mdash: '-', ndash: '-' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Convert an HTML page into compact markdown-ish text: headings, links, lists and code survive; scripts and styles do not. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '');
  const blocks: string[] = [];
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => `\n@@PRE${blocks.push(decodeEntities(code.replace(/<[^>]+>/g, '')).replace(/^\n|\n$/g, '')) - 1}@@\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${t}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, d: string, sq: string, t: string) => {
      const href = d ?? sq;
      const label = t.replace(/<[^>]+>/g, '').trim();
      return label && !/^(#|javascript:)/i.test(href) ? `[${label}](${href})` : label;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>|<\/(p|div|section|article|header|footer|tr|ul|ol|table|blockquote)>/gi, '\n')
    .replace(/<(p|div|section|article|header|footer|tr|ul|ol|table|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/@@PRE(\d+)@@/g, (_m, i: string) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``);
  return { title, text: s };
}

// ---- fetch ---------------------------------------------------------------------

export interface WebFetchOptions {
  url: string;
  timeoutMs: number;
  trustedHosts: string[];
  /** Characters to skip, for paging through a long page. */
  offset?: number;
  maxChars?: number;
  /** Return the body as received instead of converting HTML. */
  raw?: boolean;
}

async function readCapped(res: Response): Promise<{ text: string; capped: boolean }> {
  if (!res.body) return { text: '', capped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > MAX_BODY_BYTES) {
      capped = true;
      await reader.cancel();
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), capped };
}

/** GET a public web page and return it as readable text. Redirects are followed and re-checked at every hop. */
export async function webFetch(opts: WebFetchOptions): Promise<string> {
  let url = await assertPublicUrl(opts.url, opts.trustedHosts);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  const headers = { 'user-agent': 'copilot-workspace-mcp/web_fetch', accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' };
  const hops: string[] = [];

  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, { headers, redirect: 'manual', signal });
    } catch (err) {
      if (signal.aborted) throw new Error(`Request timed out after ${Math.round(opts.timeoutMs / 1000)}s.`);
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      throw new Error(`Request failed: ${cause?.message ?? cause?.code ?? (err as Error).message}`);
    }
    const location = res.headers.get('location');
    if (location && res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) throw new Error(`Stopped after ${MAX_REDIRECTS} redirects.`);
      await res.body?.cancel();
      url = await assertPublicUrl(new URL(location, url).href, opts.trustedHosts);
      hops.push(url.href);
      continue;
    }

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const textual = !type || /^text\/|json|xml|javascript|yaml|markdown/.test(type);
    if (!textual) {
      await res.body?.cancel();
      throw new AccessError(`Unsupported content type "${type}" (${res.status}); web_fetch returns text pages only.`);
    }
    const { text: body, capped } = await readCapped(res);
    let title = '';
    let content = body;
    if (!opts.raw && /html/.test(type)) {
      ({ title, text: content } = htmlToText(body));
    } else if (/json/.test(type)) {
      try {
        content = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        /* show as received */
      }
    }
    const offset = Math.max(0, opts.offset ?? 0);
    const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
    const slice = content.slice(offset, offset + max);
    const more = offset + max < content.length ? `\n[showing chars ${offset}-${offset + slice.length} of ${content.length}; use offset=${offset + slice.length} for more]` : '';
    const note = capped ? `\n[download stopped at ${MAX_BODY_BYTES} bytes]` : '';
    const head = [`URL: ${url.href}`, hops.length ? `redirects: ${hops.join(' -> ')}` : '', `HTTP ${res.status} ${res.statusText}`.trim(), type && `type: ${type}`, title && `title: ${title}`]
      .filter(Boolean)
      .join('\n');
    return `${head}\n\n${slice || '(empty body)'}${more}${note}`;
  }
}

// ---- search --------------------------------------------------------------------

export interface WebSearchOptions {
  query: string;
  /** Brave Search API compatible endpoint. */
  endpoint: string;
  apiKey: string;
  count: number;
  timeoutMs: number;
}

/** Query the Brave Search API and format the top results. */
export async function webSearch(opts: WebSearchOptions): Promise<string> {
  const query = opts.query.trim();
  if (!query) throw new AccessError('query is required.');
  const url = new URL(opts.endpoint);
  url.searchParams.set('q', query.slice(0, 400));
  url.searchParams.set('count', String(opts.count));
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': opts.apiKey },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    throw new Error(`Search request failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Search provider returned HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check BRAVE_API_KEY)' : ''}.`);
  const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  const results = data.web?.results ?? [];
  if (!results.length) return `No results for "${query}".`;
  const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ''));
  return results
    .slice(0, opts.count)
    .map((r, i) => `${i + 1}. ${strip(r.title ?? '(untitled)')}\n   ${r.url ?? ''}\n   ${strip(r.description ?? '')}`)
    .join('\n\n');
}
