import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { StateStore, WorkspaceRow } from './db.js';
import { AccessError, assertAlias, isInside } from './security.js';

/** Per-request context derived from transport (HTTP headers / stdio). */
export interface RequestContext {
  /** Conversation id from the `conversation-id` header (Copilot Studio). */
  conversationKey?: string;
  /** Free-form client label stored with bindings, e.g. 'copilot-studio', 'http', 'stdio'. */
  client: string;
}

/** Workspace selectors every tool accepts. */
export interface WorkspaceSelector {
  workspace?: string;
  conversationId?: string;
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
  async add(alias: string, folder: string, makeDefault = false) {
    assertAlias(alias);
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
      real = await fs.realpath(folder);
    } catch {
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
