import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { StateStore, WorkspaceRow } from './db.js';
import {
  AccessError,
  assertAlias,
  cleanAbsolutePath,
  isAbsoluteLike,
  isInside,
  matchIgnoringSpaces,
  realpathOfExistingAncestor,
  sameIgnoringSpaces,
  splitAbsolute,
  unquote,
} from './security.js';

const fileExists = (p: string) => fs.stat(p).then(() => true, () => false);

/** Per-request context derived from transport (HTTP headers / stdio). */
export interface RequestContext {
  /** Conversation id from the `conversation-id` header (Copilot Studio). */
  conversationKey?: string;
  /** Free-form client label stored with bindings, e.g. 'copilot-studio', 'http', 'stdio'. */
  client: string;
}

/** Workspace selectors every tool accepts. */
export interface WorkspaceSelector {
  /** null is accepted: Copilot Studio sends null for optional inputs left empty. */
  workspace?: string | null;
  conversationId?: string | null;
}

export type ResolutionSource = 'argument' | 'conversation' | 'default';

export interface ResolvedWorkspace {
  alias: string;
  root: string;
  source: ResolutionSource;
  conversationKey?: string;
}

const DEFAULT_KEY = 'default_workspace';

export class WorkspaceService {
  constructor(
    private readonly store: StateStore,
    private readonly config: AppConfig,
  ) {}

  /** Conversation key: explicit tool argument wins over the header. */
  conversationKey(ctx: RequestContext, sel: WorkspaceSelector): string | undefined {
    const key = (sel.conversationId ?? '').trim() || (ctx.conversationKey ?? '').trim();
    if (!key) return undefined;
    if (key.length > 256) throw new AccessError('conversationId is too long.');
    return key;
  }

  /**
   * Resolution order: explicit `workspace` argument -> conversation binding -> default.
   * Never silently falls back to an arbitrary folder.
   */
  async resolve(ctx: RequestContext, sel: WorkspaceSelector): Promise<ResolvedWorkspace> {
    const conversationKey = this.conversationKey(ctx, sel);
    let row: WorkspaceRow | undefined;
    let source: ResolutionSource;

    if (sel.workspace?.trim()) {
      row = this.requireWorkspace(sel.workspace.trim());
      source = 'argument';
    } else if (conversationKey && (row = this.bindingWorkspace(conversationKey))) {
      this.store.touchBinding(conversationKey);
      source = 'conversation';
    } else {
      const def = this.store.getSetting(DEFAULT_KEY);
      row = def ? this.store.getWorkspace(def) : undefined;
      if (!row) {
        throw new AccessError(
          `No workspace selected for this chat. Call switch_workspace first or pass "workspace". ${this.availableText()}`,
        );
      }
      source = 'default';
    }

    await this.assertDirectory(row.root_path, row.alias);
    this.store.touchWorkspace(row.alias);
    return { alias: row.alias, root: row.root_path, source, conversationKey };
  }

  /**
   * Resolve the workspace for a file path. Relative paths use the normal resolution
   * order. Absolute paths (incl. quoted or file:// forms) are routed to the registered
   * workspace that contains them, preferring the chat's own workspace, and converted to
   * a workspace-relative path. Containment is checked on the real path (links followed),
   * and the result is still validated by resolveInside by the caller.
   */
  async resolveForPath(
    ctx: RequestContext,
    sel: WorkspaceSelector,
    rawPath: string,
  ): Promise<{ ws: ResolvedWorkspace; relPath: string }> {
    const cleaned = typeof rawPath === 'string' ? cleanAbsolutePath(rawPath) : rawPath;
    if (typeof cleaned !== 'string' || !isAbsoluteLike(cleaned)) {
      return { ws: await this.resolve(ctx, sel), relPath: cleaned };
    }
    if (cleaned.includes('\0')) throw new AccessError('Invalid path.');
    let abs = path.resolve(cleaned);
    if (!(await fileExists(abs))) {
      // e.g. "D:\RedFiles\..." sent for "D:\Red Files\...".
      const { base, segments } = splitAbsolute(abs);
      abs = (await matchIgnoringSpaces(base, segments, true)) ?? abs;
    }
    const real = await realpathOfExistingAncestor(abs);
    const alias = await this.workspaceContaining(real, ctx, sel);
    const ws = await this.resolve(ctx, { ...sel, workspace: alias });
    const realRoot = await fs.realpath(ws.root);
    // Forward slashes, matching list_files output and how relative paths are usually written.
    return { ws, relPath: path.relative(realRoot, real).split(path.sep).join('/') || '.' };
  }

  /**
   * Same as resolveForPath for glob patterns: an absolute pattern such as
   * "D:/Red Files/Projects/PDCS2022/host-vite/**\/*.vue" becomes "host-vite/**\/*.vue" in
   * workspace PDCS. Matching is textual on the static prefix (globs cannot be realpath'd).
   */
  async resolveForPattern(
    ctx: RequestContext,
    sel: WorkspaceSelector,
    rawPattern: string,
  ): Promise<{ ws: ResolvedWorkspace; pattern: string }> {
    const cleaned = cleanAbsolutePath(rawPattern);
    if (!isAbsoluteLike(cleaned)) return { ws: await this.resolve(ctx, sel), pattern: cleaned };
    const segs = (p: string) => p.split(/[\\/]+/).filter(Boolean);
    const patSegs = segs(cleaned);
    const current = await this.currentAlias(ctx, sel);
    // Compare folder by folder, ignoring spaces/case ("D:/RedFiles/..." matches "D:\Red Files").
    const hits = this.store
      .listWorkspaces()
      .map((w) => ({ alias: w.alias, rootSegs: segs(w.root_path) }))
      .filter((w) => w.rootSegs.length <= patSegs.length && w.rootSegs.every((s, i) => sameIgnoringSpaces(s, patSegs[i])))
      .sort(
        (a, b) => Number(b.alias === current) - Number(a.alias === current) || b.rootSegs.length - a.rootSegs.length,
      );
    if (!hits.length) throw this.outsideError(rawPattern);
    const ws = await this.resolve(ctx, { ...sel, workspace: hits[0].alias });
    return { ws, pattern: patSegs.slice(hits[0].rootSegs.length).join('/') || '**/*' };
  }

  /** Bind the chat to a workspace (and/or make it the default). */
  async switchTo(ctx: RequestContext, sel: WorkspaceSelector & { makeDefault?: boolean }) {
    const alias = (sel.workspace ?? '').trim();
    const row = this.requireWorkspace(alias);
    await this.assertDirectory(row.root_path, row.alias);
    const conversationKey = this.conversationKey(ctx, sel);
    if (conversationKey) this.store.bind(conversationKey, row.alias, ctx.client);
    if (sel.makeDefault) this.store.setSetting(DEFAULT_KEY, row.alias);
    this.store.touchWorkspace(row.alias);
    return { alias: row.alias, root: row.root_path, boundToConversation: !!conversationKey, madeDefault: !!sel.makeDefault };
  }

  /** Forget the chat's binding (it falls back to the default). */
  clearBinding(ctx: RequestContext, sel: WorkspaceSelector): boolean {
    const key = this.conversationKey(ctx, sel);
    return key ? this.store.unbind(key) : false;
  }

  list(ctx: RequestContext, sel: WorkspaceSelector) {
    const key = this.conversationKey(ctx, sel);
    const bound = key ? this.store.getBinding(key)?.alias : undefined;
    const def = this.store.getSetting(DEFAULT_KEY);
    return this.store.listWorkspaces().map((w) => ({
      alias: w.alias,
      path: w.root_path,
      isDefault: w.alias === def,
      isCurrentChat: w.alias === bound,
      lastUsedAt: w.last_used_at,
    }));
  }

  getDefault(): string | undefined {
    return this.store.getSetting(DEFAULT_KEY);
  }

  setDefault(alias: string) {
    this.requireWorkspace(alias);
    this.store.setSetting(DEFAULT_KEY, alias);
  }

  /** Register a new workspace. Only allowed under ALLOWED_ROOTS. */
  async add(alias: string, rawFolder: string, makeDefault = false) {
    alias = unquote(alias);
    assertAlias(alias);
    // Accept "D:/Red Files/x", '"D:/Red Files/x"' and file:///D:/Red%20Files/x alike.
    const folder = cleanAbsolutePath(rawFolder);
    if (this.config.allowedRoots.length === 0) {
      throw new AccessError('Adding workspaces is disabled. Set ALLOWED_ROOTS on the server to enable it.');
    }
    if (!path.isAbsolute(folder)) throw new AccessError('Workspace path must be absolute.');
    const real = await this.realDirectory(folder);
    const roots = await Promise.all(this.config.allowedRoots.map((r) => fs.realpath(r).catch(() => r)));
    if (!roots.some((r) => isInside(r, real))) {
      throw new AccessError(`"${folder}" is outside the allowed roots: ${this.config.allowedRoots.join('; ')}`);
    }
    if (isInside(real, path.dirname(this.config.stateDbPath))) {
      throw new AccessError('A workspace may not contain the server state directory.');
    }
    const existingAlias = this.store.getWorkspace(alias);
    if (existingAlias && existingAlias.root_path !== real) {
      throw new AccessError(`Alias "${alias}" already points to ${existingAlias.root_path}.`);
    }
    const existingPath = this.store.getWorkspaceByPath(real);
    if (existingPath && existingPath.alias !== alias) {
      throw new AccessError(`That folder is already registered as "${existingPath.alias}".`);
    }
    this.store.upsertWorkspace(alias, real);
    if (makeDefault || !this.getDefault()) this.store.setSetting(DEFAULT_KEY, alias);
    return { alias, path: real, isDefault: this.getDefault() === alias };
  }

  remove(alias: string): { removed: boolean; seeded: boolean } {
    const removed = this.store.removeWorkspace(alias);
    return { removed, seeded: this.config.seedWorkspaces.has(alias) };
  }

  /** Register WORKSPACES / WORKSPACE_ROOT entries at startup. Returns warnings. */
  async seed(): Promise<string[]> {
    const warnings: string[] = [];
    for (const [alias, folder] of this.config.seedWorkspaces) {
      try {
        assertAlias(alias);
        const real = await this.realDirectory(folder);
        if (isInside(real, path.dirname(this.config.stateDbPath))) {
          throw new AccessError('a workspace may not contain the server state directory');
        }
        const byPath = this.store.getWorkspaceByPath(real);
        if (byPath && byPath.alias !== alias) {
          warnings.push(`Seed "${alias}" skipped: ${real} is already registered as "${byPath.alias}".`);
          continue;
        }
        this.store.upsertWorkspace(alias, real);
      } catch (err) {
        warnings.push(`Seed "${alias}" (${folder}) skipped: ${(err as Error).message}`);
      }
    }
    if (this.config.defaultWorkspace) {
      if (this.store.getWorkspace(this.config.defaultWorkspace)) {
        this.store.setSetting(DEFAULT_KEY, this.config.defaultWorkspace);
      } else {
        warnings.push(`DEFAULT_WORKSPACE "${this.config.defaultWorkspace}" is not registered.`);
      }
    } else if (!this.getDefault()) {
      const first = [...this.config.seedWorkspaces.keys()].find((a) => this.store.getWorkspace(a));
      if (first) this.store.setSetting(DEFAULT_KEY, first);
    }
    return warnings;
  }

  availableText(): string {
    const aliases = this.store.listWorkspaces().map((w) => w.alias);
    return aliases.length ? `Available workspaces: ${aliases.join(', ')}.` : 'No workspaces are registered yet.';
  }

  // ---- helpers ----------------------------------------------------------

  /** Alias resolve() would pick, without side effects or errors. */
  private async currentAlias(ctx: RequestContext, sel: WorkspaceSelector): Promise<string | undefined> {
    if (sel.workspace?.trim()) return sel.workspace.trim();
    const key = this.conversationKey(ctx, sel);
    return (key && this.store.getBinding(key)?.alias) || this.getDefault();
  }

  /** Registered workspace whose real root contains `realPath`: the chat's own first, then the deepest. */
  private async workspaceContaining(realPath: string, ctx: RequestContext, sel: WorkspaceSelector): Promise<string> {
    const current = await this.currentAlias(ctx, sel);
    const hits: { alias: string; root: string }[] = [];
    for (const w of this.store.listWorkspaces()) {
      const root = await fs.realpath(w.root_path).catch(() => undefined);
      if (root && isInside(root, realPath)) hits.push({ alias: w.alias, root });
    }
    hits.sort((a, b) => Number(b.alias === current) - Number(a.alias === current) || b.root.length - a.root.length);
    if (!hits.length) throw this.outsideError(realPath);
    return hits[0].alias;
  }

  private outsideError(p: string): AccessError {
    const roots = this.store.listWorkspaces().map((w) => `${w.alias} = ${w.root_path}`);
    return new AccessError(
      `"${p}" is not inside any registered workspace. Use a path relative to the workspace root, ` +
        `or register the folder with add_workspace. ${roots.length ? `Registered: ${roots.join('; ')}.` : this.availableText()}`,
    );
  }

  private requireWorkspace(alias: string): WorkspaceRow {
    const row = alias ? this.store.getWorkspace(alias) : undefined;
    if (!row) throw new AccessError(`Unknown workspace "${alias}". ${this.availableText()}`);
    return row;
  }

  private bindingWorkspace(key: string): WorkspaceRow | undefined {
    const b = this.store.getBinding(key);
    return b ? this.store.getWorkspace(b.alias) : undefined;
  }

  private async realDirectory(folder: string): Promise<string> {
    let real: string;
    try {
      real = await fs.realpath(folder).catch(async (err) => {
        // Client dropped/added spaces ("D:\RedFiles\..." for "D:\Red Files\...").
        const { base, segments } = splitAbsolute(folder);
        const fixed = await matchIgnoringSpaces(base, segments);
        if (!fixed) throw err;
        return fs.realpath(fixed);
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Diagnostics go to stderr (stdout is reserved for the stdio transport).
      console.error('[realDirectory]', { folder, abs: path.resolve(folder), cwd: process.cwd(), code: e?.code, msg: e?.message });
      throw new AccessError(`Folder does not exist: ${folder}`);
    }
    if (!(await fs.stat(real)).isDirectory()) throw new AccessError(`Not a folder: ${folder}`);
    return real;
  }

  private async assertDirectory(root: string, alias: string) {
    try {
      if ((await fs.stat(root)).isDirectory()) return;
    } catch {
      /* fall through */
    }
    throw new AccessError(`Workspace "${alias}" folder is missing: ${root}`);
  }
}
