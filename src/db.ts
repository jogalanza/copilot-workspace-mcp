import fs from 'node:fs';
import path from 'node:path';
import * as sqlite from 'node:sqlite';

// Node 26.11 renamed DatabaseSync -> Database (DatabaseSync kept as a deprecated alias).
type Db = sqlite.DatabaseSync;
const DatabaseCtor: typeof sqlite.DatabaseSync =
  ((sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database) ?? sqlite.DatabaseSync;

export interface WorkspaceRow {
  alias: string;
  root_path: string;
  created_at: string;
  last_used_at: string | null;
}

export interface BindingRow {
  conversation_key: string;
  alias: string;
  client: string;
  updated_at: string;
}

export interface AuditEntry {
  conversationKey?: string;
  tool: string;
  alias?: string;
  relPath?: string;
  ok: boolean;
  error?: string;
}

const SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE workspaces (
      alias        TEXT PRIMARY KEY,
      root_path    TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL,
      last_used_at TEXT
    ) STRICT;

    CREATE TABLE bindings (
      conversation_key TEXT PRIMARY KEY,
      alias            TEXT NOT NULL REFERENCES workspaces(alias) ON DELETE CASCADE ON UPDATE CASCADE,
      client           TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    ) STRICT;
    CREATE INDEX bindings_updated_at ON bindings(updated_at);

    CREATE TABLE audit_log (
      id               INTEGER PRIMARY KEY,
      ts               TEXT NOT NULL,
      conversation_key TEXT,
      tool             TEXT NOT NULL,
      alias            TEXT,
      rel_path         TEXT,
      ok               INTEGER NOT NULL,
      error            TEXT
    ) STRICT;
    CREATE INDEX audit_log_ts ON audit_log(ts);

    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `,
};

const now = () => new Date().toISOString();

/** Plain objects (node:sqlite rows have a null prototype). */
function plain<T>(row: unknown): T {
  return row ? ({ ...(row as object) } as T) : (undefined as T);
}

/**
 * Persistent state: workspace registry, per-conversation bindings, audit log, settings.
 * All calls are synchronous single-row operations (fast; safe on the event loop).
 */
export class StateStore {
  private db: Db;

  constructor(readonly filePath: string) {
    if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseCtor(filePath, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (filePath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate() {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (current > SCHEMA_VERSION) {
      throw new Error(`State DB schema v${current} is newer than this server (v${SCHEMA_VERSION}).`);
    }
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  // ---- workspaces -------------------------------------------------------

  upsertWorkspace(alias: string, rootPath: string) {
    this.db
      .prepare(
        `INSERT INTO workspaces (alias, root_path, created_at) VALUES (?, ?, ?)
         ON CONFLICT(alias) DO UPDATE SET root_path = excluded.root_path`,
      )
      .run(alias, rootPath, now());
  }

  getWorkspace(alias: string): WorkspaceRow | undefined {
    return plain(this.db.prepare('SELECT * FROM workspaces WHERE alias = ?').get(alias));
  }

  getWorkspaceByPath(rootPath: string): WorkspaceRow | undefined {
    return plain(this.db.prepare('SELECT * FROM workspaces WHERE root_path = ?').get(rootPath));
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db.prepare('SELECT * FROM workspaces ORDER BY alias').all().map((r) => plain<WorkspaceRow>(r));
  }

  removeWorkspace(alias: string): boolean {
    return this.transaction(() => {
      if (this.getSetting('default_workspace') === alias) this.deleteSetting('default_workspace');
      return Number(this.db.prepare('DELETE FROM workspaces WHERE alias = ?').run(alias).changes) > 0;
    });
  }

  touchWorkspace(alias: string) {
    this.db.prepare('UPDATE workspaces SET last_used_at = ? WHERE alias = ?').run(now(), alias);
  }

  // ---- bindings ---------------------------------------------------------

  bind(conversationKey: string, alias: string, client: string) {
    this.db
      .prepare(
        `INSERT INTO bindings (conversation_key, alias, client, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_key) DO UPDATE SET alias = excluded.alias, client = excluded.client,
           updated_at = excluded.updated_at`,
      )
      .run(conversationKey, alias, client, now());
  }

  getBinding(conversationKey: string): BindingRow | undefined {
    return plain(this.db.prepare('SELECT * FROM bindings WHERE conversation_key = ?').get(conversationKey));
  }

  /** Refresh the TTL clock of a binding that is being used. */
  touchBinding(conversationKey: string) {
    this.db.prepare('UPDATE bindings SET updated_at = ? WHERE conversation_key = ?').run(now(), conversationKey);
  }

  unbind(conversationKey: string): boolean {
    return Number(this.db.prepare('DELETE FROM bindings WHERE conversation_key = ?').run(conversationKey).changes) > 0;
  }

  /** Delete bindings not used for `days` days. Returns number removed. */
  purgeBindings(days: number, at: Date = new Date()): number {
    const cutoff = new Date(at.getTime() - days * 86_400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM bindings WHERE updated_at < ?').run(cutoff).changes);
  }

  // ---- settings ---------------------------------------------------------

  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
      ?.value;
  }

  setSetting(key: string, value: string) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteSetting(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  // ---- audit ------------------------------------------------------------

  audit(e: AuditEntry) {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, conversation_key, tool, alias, rel_path, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(now(), e.conversationKey ?? null, e.tool, e.alias ?? null, e.relPath ?? null, e.ok ? 1 : 0, e.error ?? null);
  }

  recentAudit(limit = 50) {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit).map((r) => plain(r));
  }

  /** Keep the audit log bounded. */
  purgeAudit(days: number, at: Date = new Date()): number {
    const cutoff = new Date(at.getTime() - days * 86_400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff).changes);
  }
}
