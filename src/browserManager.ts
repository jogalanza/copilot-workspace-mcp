import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { AppConfig } from './config.js';
import { AccessError } from './security.js';

const MAX_SESSIONS = 5;
const MAX_LOG_ENTRIES = 200;
const NAV_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 10_000;

/** True if `hostname` equals an allowed entry or matches a "*.example.com" entry. */
export function isHostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry,
  );
}

/**
 * Only http(s) URLs on allowed hosts may be loaded. Without this an agent could use the
 * browser as a proxy into the intranet (SSRF), so the default allowlist is localhost only.
 */
export function assertUrlAllowed(rawUrl: string, allowed: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new AccessError(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AccessError(`Only http(s) URLs are allowed (got "${url.protocol}").`);
  }
  if (!isHostAllowed(url.hostname, allowed)) {
    throw new AccessError(
      `Host "${url.hostname}" is not allowed. Allowed: ${allowed.join(', ')}. ` +
        'The server admin can extend BROWSER_ALLOWED_HOSTS.',
    );
  }
  return url;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  logs: string[];
  lastUsed: number;
}

export class BrowserManager {
  private browser: Promise<Browser> | undefined;
  private sessions = new Map<string, BrowserSession>();
  private sweeper: NodeJS.Timeout;

  constructor(private config: AppConfig) {
    this.sweeper = setInterval(() => void this.closeIdle(), 60_000);
    this.sweeper.unref();
  }

  get allowedHosts() {
    return this.config.browserAllowedHosts;
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        const { chromium } = await import('playwright-core');
        try {
          const b = await chromium.launch({
            headless: true,
            ...(this.config.browserExecutable
              ? { executablePath: this.config.browserExecutable }
              : { channel: this.config.browserChannel }),
          });
          b.on('disconnected', () => {
            this.browser = undefined;
            this.sessions.clear();
          });
          return b;
        } catch (err) {
          this.browser = undefined;
          throw new AccessError(
            `Could not start a headless browser (${this.config.browserExecutable ?? this.config.browserChannel}). ` +
              'Install Microsoft Edge or Chrome, or set BROWSER_CHANNEL / BROWSER_EXECUTABLE. ' +
              `Details: ${(err as Error).message.split('\n')[0]}`,
          );
        }
      })();
    }
    return this.browser;
  }

  /** One isolated browser context + tab per chat (key). */
  async session(key: string): Promise<BrowserSession> {
    const existing = this.sessions.get(key);
    if (existing && !existing.page.isClosed()) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) this.sessions.delete(key);
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      await this.closeSession(oldest[0]);
    }

    const browser = await this.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    const logs: string[] = [];
    const log = (line: string) => {
      logs.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      if (logs.length > MAX_LOG_ENTRIES) logs.shift();
    };

    // Every request (including redirects and sub-resources) must target an allowed host.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (/^(data|blob|about):/i.test(url)) return route.continue();
      try {
        assertUrlAllowed(url, this.config.browserAllowedHosts);
        return route.continue();
      } catch {
        log(`[blocked] ${url}`);
        return route.abort('blockedbyclient');
      }
    });
    await context.routeWebSocket(/.*/, (ws) => {
      try {
        assertUrlAllowed(ws.url().replace(/^ws/i, 'http'), this.config.browserAllowedHosts);
        ws.connectToServer();
      } catch {
        log(`[blocked] ${ws.url()}`);
        void ws.close();
      }
    });

    const page = await context.newPage();
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type())) log(`[console.${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => log(`[requestfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('response', (r) => {
      if (r.status() >= 400) log(`[http ${r.status()}] ${r.request().method()} ${r.url()}`);
    });

    const session = { context, page, logs, lastUsed: Date.now() };
    this.sessions.set(key, session);
    return session;
  }

  async closeSession(key: string) {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    await s?.context.close().catch(() => undefined);
  }

  private async closeIdle() {
    const cutoff = Date.now() - this.config.browserIdleMinutes * 60_000;
    for (const [key, s] of this.sessions) if (s.lastUsed < cutoff) await this.closeSession(key);
    if (this.sessions.size === 0 && this.browser) {
      const b = await this.browser.catch(() => undefined);
      this.browser = undefined;
      await b?.close().catch(() => undefined);
    }
  }

  async shutdown() {
    clearInterval(this.sweeper);
    const b = await this.browser?.catch(() => undefined);
    this.browser = undefined;
    this.sessions.clear();
    await b?.close().catch(() => undefined);
  }
}
