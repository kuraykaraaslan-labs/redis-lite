import { formatMessage } from '@/libs/message-format';
import { RespError, Status } from '@/libs/resp';

import type { Client } from './server.client';
import type { RedisLiteServer } from './server.core';
import ServerMessages from './server.messages';
import type { CommandStat, LatencyEvent } from './server.types';

// ============================================================================
// Argument Rendering (SLOWLOG, MONITOR)
// ============================================================================

const SLOWLOG_ENTRY_MAX_ARGC = 32;
const SLOWLOG_ENTRY_MAX_STRING = 128;

const REPR_ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x07': '\\a', '\b': '\\b' };

/** Redis slowlogCreateEntry(): at most 32 arguments, each at most 128 bytes. */
function slowlogArgv(argv: string[]): string[] {
  const argc = Math.min(argv.length, SLOWLOG_ENTRY_MAX_ARGC);
  const out: string[] = [];
  for (let i = 0; i < argc; i++) {
    if (argc !== argv.length && i === argc - 1) {
      out.push(formatMessage(ServerMessages.SLOWLOG_MORE_ARGS, { count: argv.length - argc + 1 }));
    } else if (argv[i].length > SLOWLOG_ENTRY_MAX_STRING) {
      const prefix = argv[i].slice(0, SLOWLOG_ENTRY_MAX_STRING);
      out.push(formatMessage(ServerMessages.SLOWLOG_MORE_BYTES, { prefix, count: argv[i].length - SLOWLOG_ENTRY_MAX_STRING }));
    } else out.push(argv[i]);
  }
  return out;
}

/** Redis sdscatrepr() body (MONITOR): C escapes for \\ " \n \r \t \a \b, \xHH for other non-printable bytes. */
function reprString(s: string): string {
  return s.replace(/[\\"\x00-\x1f\x7f-\xff]/g, (c) => REPR_ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Arguments Redis replaces with "(redacted)" in SLOWLOG and MONITOR (passwords). */
function redact(argv: string[]): string[] {
  const name = argv[0].toLowerCase();
  if (name === 'auth') return argv.map((a, i) => (i === 0 ? a : ServerMessages.REDACTED));
  if (name === 'acl' && argv[1]?.toLowerCase() === 'setuser') return argv.map((a, i) => (i < 2 ? a : ServerMessages.REDACTED));
  if (name === 'config' && argv[1]?.toLowerCase() === 'set') {
    // sensitive configs (requirepass, masterauth) have their value redacted
    return argv.map((a, i) => (i > 2 && i % 2 === 1 && /^(requirepass|masterauth)$/i.test(argv[i - 1]) ? ServerMessages.REDACTED : a));
  }
  if (name === 'hello') {
    const out = [...argv];
    for (let i = 2; i < out.length; i++) {
      if (out[i].toLowerCase() === 'auth' && i + 2 < out.length) {
        out[i + 1] = ServerMessages.REDACTED;
        out[i + 2] = ServerMessages.REDACTED;
        i += 2;
      } else if (out[i].toLowerCase() === 'setname') i++;
    }
    return out;
  }
  return argv;
}

// ============================================================================
// Observer
// ============================================================================

/** What the server reports about itself: INFO stats / commandstats / errorstats counters, SLOWLOG, the MONITOR feed. */
export class ServerObserver {
  private slowlogNextId = 0;
  /** Latency monitor events by name (`command`, `fast-command`), in the order they first happened. */
  readonly latencyEvents = new Map<string, LatencyEvent>();

  constructor(private readonly server: RedisLiteServer) {}

  /** INFO errorstats / total_error_replies. */
  countError(message: string): void {
    const { stats, errorStats } = this.server;
    stats.errorReplies++;
    const space = message.indexOf(' ');
    const code = space < 0 ? message : message.slice(0, space);
    if (errorStats.has(code) || errorStats.size < 128) errorStats.set(code, (errorStats.get(code) ?? 0) + 1);
  }

  /** An error reply produced outside a command (NOAUTH, queueing errors…): counted in INFO errorstats. */
  replyError(client: Client, message: string): void {
    this.countError(message);
    client.write(new RespError(message));
  }

  /** The INFO commandstats entry of a command (created on first use). */
  commandStat(name: string): CommandStat {
    const stats = this.server.commandStats;
    let stat = stats.get(name);
    if (!stat) stats.set(name, (stat = { calls: 0, usec: 0, rejected: 0, failed: 0 }));
    return stat;
  }

  /** CONFIG RESETSTAT. */
  resetStats(): void {
    const { stats } = this.server;
    stats.commands = 0;
    stats.connections = 0;
    stats.expired = 0;
    stats.errorReplies = 0;
    stats.netIn = 0;
    stats.netOut = 0;
    stats.keyspaceHits = 0;
    stats.keyspaceMisses = 0;
    this.server.commandStats.clear();
    this.server.errorStats.clear();
  }

  slowlogReset(): void {
    this.server.slowlog.length = 0;
  }

  /** Records a command slower than slowlog-log-slower-than (newest first, at most slowlog-max-len entries). */
  slowlogPush(client: Client, argv: string[], usec: number): void {
    const { config, slowlog } = this.server;
    const threshold = config.num('slowlog-log-slower-than');
    const maxLen = config.num('slowlog-max-len');
    if (threshold < 0 || maxLen === 0 || usec < threshold) return;
    slowlog.unshift({
      id: this.slowlogNextId++,
      time: Math.floor(Date.now() / 1000),
      usec,
      argv: slowlogArgv(redact(argv)),
      addr: client.address,
      name: client.name,
    });
    if (slowlog.length > maxLen) slowlog.length = maxLen;
  }

  /**
   * Latency monitor: a command that took at least latency-monitor-threshold ms (0 = monitoring off) is a sample of the
   * `command` event (`fast-command` for a fast command). One sample per second is kept (the largest), at most 160.
   */
  latencySample(event: string, usec: number): void {
    const threshold = this.server.config.num('latency-monitor-threshold');
    const ms = Math.floor(usec / 1000);
    if (threshold <= 0 || ms < threshold) return;
    const now = Math.floor(Date.now() / 1000);
    let e = this.latencyEvents.get(event);
    if (!e) this.latencyEvents.set(event, (e = { samples: [], max: 0 }));
    const last = e.samples[e.samples.length - 1];
    if (last && last[0] === now) last[1] = Math.max(last[1], ms);
    else e.samples.push([now, ms]);
    if (e.samples.length > 160) e.samples.shift();
    e.max = Math.max(e.max, ms);
  }

  /** MONITOR: one line per command to every monitor but the caller. */
  feedMonitors(client: Client, argv: string[], inScript: boolean): void {
    const now = Date.now();
    const ts = `${Math.floor(now / 1000)}.${String((now % 1000) * 1000).padStart(6, '0')}`;
    const origin = inScript ? 'lua' : client.address;
    const args = redact(argv).map((a) => `"${reprString(a)}"`);
    const line = new Status(`${ts} [${client.dbIndex} ${origin}] ${args.join(' ')}`);
    for (const m of this.server.monitors) if (m !== client) m.write(line);
  }
}
