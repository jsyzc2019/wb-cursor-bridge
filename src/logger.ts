/**
 * Structured logger.
 *
 * Two hard rules on a stdio MCP server:
 *   1. stdout belongs to the protocol - nothing else may ever write there
 *   2. diagnostics must survive after the parent UI has gone away
 * So human output goes to stderr and a rotating JSONL file goes to the state
 * directory, where it can be tailed by support tooling.
 */
import fs from 'node:fs';
import path from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: Level;
  fileDir?: string;
  /** Max bytes before the active log file is rotated. */
  maxBytes?: number;
  /** Number of rotated files to keep. */
  keep?: number;
  /** Emit to stderr. Must stay true for a stdio server. */
  stderr?: boolean;
}

export class Logger {
  private level: Level;
  private fileDir?: string;
  private maxBytes: number;
  private keep: number;
  private toStderr: boolean;
  /** Estimated current log file size; reset after rotation. */
  private fileSize = 0;
  /** Number of appends since the last size/stat check. */
  private writesSinceCheck = 0;
  /** Check size on disk every N writes to bound estimation drift. */
  private static readonly CHECK_INTERVAL = 50;

  constructor(opts: Partial<LoggerOptions> = {}) {
    this.level = opts.level ?? 'info';
    this.fileDir = opts.fileDir;
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.keep = opts.keep ?? 3;
    this.toStderr = opts.stderr ?? true;
  }

  setLevel(level: Level): void {
    this.level = level;
  }

  child(scope: string): Logger {
    const child = new Logger({
      level: this.level,
      fileDir: this.fileDir,
      maxBytes: this.maxBytes,
      keep: this.keep,
      stderr: this.toStderr,
    });
    child.scope = scope;
    return child;
  }

  private scope = '';

  private write(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const rec = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(this.scope ? { scope: this.scope } : {}),
      ...fields,
    };
    if (this.toStderr) {
      const extra = fields ? ' ' + safeJson(fields) : '';
      process.stderr.write(
        `[wb-cursor-bridge][${level}]${this.scope ? `[${this.scope}]` : ''} ${msg}${extra}\n`,
      );
    }
    if (this.fileDir) this.appendFile(rec);
  }

  private appendFile(rec: unknown): void {
    try {
      fs.mkdirSync(this.fileDir!, { recursive: true });
      const file = path.join(this.fileDir!, 'bridge.log');
      const line = JSON.stringify(rec) + '\n';
      // Estimate size instead of stat-ing on every write. Stat on disk only
      // every CHECK_INTERVAL writes or when the estimate exceeds the cap,
      // whichever comes first.
      this.fileSize += Buffer.byteLength(line, 'utf8');
      this.writesSinceCheck += 1;
      if (this.writesSinceCheck >= Logger.CHECK_INTERVAL || this.fileSize > this.maxBytes) {
        try {
          const stat = fs.statSync(file);
          if (stat.size > this.maxBytes) {
            this.rotate(file);
            this.fileSize = 0;
          } else {
            this.fileSize = stat.size + Buffer.byteLength(line, 'utf8');
          }
        } catch {
          /* first write: file does not exist yet */
        }
        this.writesSinceCheck = 0;
      }
      fs.appendFileSync(file, line, 'utf8');
    } catch {
      /* logging must never break the server */
    }
  }

  private rotate(file: string): void {
    for (let i = this.keep - 1; i >= 1; i -= 1) {
      const from = `${file}.${i}`;
      const to = `${file}.${i + 1}`;
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      /* ignore */
    }
  }

  debug(msg: string, f?: Record<string, unknown>): void {
    this.write('debug', msg, f);
  }
  info(msg: string, f?: Record<string, unknown>): void {
    this.write('info', msg, f);
  }
  warn(msg: string, f?: Record<string, unknown>): void {
    this.write('warn', msg, f);
  }
  error(msg: string, f?: Record<string, unknown>): void {
    this.write('error', msg, f);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserialisable]"';
  }
}