// In-memory ring buffer of log lines shared by the launcher and its web UI.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'launcher' | 'server' | 'tunnel';
export interface LogEntry {
  id: number;
  ts: number;
  source: LogSource;
  level: LogLevel;
  text: string;
}

type Listener = (event: { type: 'log'; entry: LogEntry } | { type: 'clear' }) => void;

export class LogBus {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();
  constructor(private readonly capacity = 2000) {}

  /** Best-effort level for lines that only carry free text. */
  static guessLevel(text: string): LogLevel {
    if (/\b(error|fatal|failed|exception|refused|denied)\b/i.test(text)) return 'error';
    if (/\b(warn|warning|retry|expired)\b/i.test(text)) return 'warn';
    return 'info';
  }

  add(source: LogSource, level: LogLevel, text: string): LogEntry {
    const entry: LogEntry = { id: this.nextId++, ts: Date.now(), source, level, text };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    for (const l of this.listeners) l({ type: 'log', entry });
    return entry;
  }

  snapshot(): LogEntry[] {
    return this.entries.slice();
  }

  clear() {
    this.entries = [];
    for (const l of this.listeners) l({ type: 'clear' });
  }

  errorCount(): number {
    return this.entries.reduce((n, e) => n + (e.level === 'error' ? 1 : 0), 0);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
