import type { LogLevel } from '@/libs/env';

/** Levels a line can be written at (`silent` is a threshold only). */
export type LogLevelName = 'error' | 'warn' | 'info' | 'debug';

/** Variable data of a log line. Never put secrets (passwords, AUTH arguments) in here. */
export type LogContext = {
  command?: string;
  durationMs?: number;
  err?: unknown;
  [key: string]: unknown;
};

/**
 * Structured logger: one JSON line per entry on stderr, e.g.
 * `{"time":"2026-11-25T12:00:00.000Z","level":"warn","message":"[RedisLiteServer.execute] Unknown command","command":"foo"}`.
 *
 * The message is a static `[Class.method] Text` string; everything variable goes in `context`. The threshold is the
 * server's `logLevel` option (set by the server at startup; `error` and `warn` lines show from `warn` up).
 * Deliberately dependency-free (no winston) so the package keeps zero logging dependencies.
 */
export default class Logger {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  private static readonly RANK: Record<LogLevel | LogLevelName, number> = { silent: 0, error: 1, warn: 1, info: 2, debug: 3 };

  private static threshold: LogLevel = 'warn';

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────
  private static write(level: LogLevelName, message: string, context: LogContext): void {
    if (Logger.RANK[level] > Logger.RANK[Logger.threshold]) return;
    const line = { time: new Date().toISOString(), level, message, ...context };
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Sets the threshold (the server's `logLevel`); with several servers in one process the last one started wins. */
  static setLevel(level: LogLevel): void {
    Logger.threshold = level;
  }

  static error(message: string, context: LogContext = {}): void {
    Logger.write('error', message, context);
  }

  static warn(message: string, context: LogContext = {}): void {
    Logger.write('warn', message, context);
  }

  static info(message: string, context: LogContext = {}): void {
    Logger.write('info', message, context);
  }

  static debug(message: string, context: LogContext = {}): void {
    Logger.write('debug', message, context);
  }
}
