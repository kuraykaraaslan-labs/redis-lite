import { randomBytes } from 'node:crypto';

import { CommandError } from '../errors';
import { unknownSubcommand } from '../messages';
import type { Reply } from '../resp';
import { OK, RespMap, RespVerbatim, Status } from '../resp';
import { matchGlob, parseInteger } from '../util';
import { ServerConfig } from '../server/config';
import { REDIS_VERSION } from './connection';
import { COMMANDS } from './index';
import type { CommandContext, CommandSpec } from './types';
import { NO_REPLY } from './types';

function info(ctx: CommandContext, args: string[]): string {
  const s = ctx.server;
  const uptime = Math.floor((Date.now() - s.startedAt) / 1000);
  const mem = process.memoryUsage().rss;
  const sections: Record<string, string[]> = {
    server: [
      `redis_version:${REDIS_VERSION}`,
      'redis_git_sha1:00000000',
      'redis_mode:standalone',
      `os:${process.platform}`,
      'arch_bits:64',
      'multiplexing_api:node',
      `process_id:${process.pid}`,
      `run_id:${s.runId}`,
      `tcp_port:${s.options.port}`,
      `uptime_in_seconds:${uptime}`,
      `uptime_in_days:${Math.floor(uptime / 86400)}`,
      'executable:redis-lite',
      'server_name:redis-lite',
    ],
    clients: [`connected_clients:${s.clients.size}`, `blocked_clients:${[...s.clients].filter((c) => c.blocked).length}`, 'maxclients:10000'],
    memory: [
      `used_memory:${mem}`,
      `used_memory_human:${(mem / 1048576).toFixed(2)}M`,
      `used_memory_rss:${mem}`,
      `used_memory_peak:${mem}`,
      'maxmemory:0',
      'maxmemory_human:0B',
      `maxmemory_policy:${s.config.get('maxmemory-policy') ?? 'noeviction'}`,
      'mem_fragmentation_ratio:1.00',
    ],
    persistence: ['loading:0', 'async_loading:0', 'rdb_changes_since_last_save:0', 'rdb_bgsave_in_progress:0', 'aof_enabled:0', 'aof_rewrite_in_progress:0'],
    stats: [
      `total_connections_received:${s.stats.connections}`,
      `total_commands_processed:${s.stats.commands}`,
      `expired_keys:${s.stats.expired}`,
      'evicted_keys:0',
      `pubsub_channels:${s.channels.size}`,
      `pubsub_patterns:${s.patterns.size}`,
    ],
    replication: ['role:master', 'connected_slaves:0', `master_replid:${s.runId}`, 'master_repl_offset:0'],
    cpu: ['used_cpu_sys:0.000000', 'used_cpu_user:0.000000'],
    modules: [],
    keyspace: s.databases
      .map((db, i) => ({ i, keys: db.size, expires: db.expiresCount }))
      .filter((d) => d.keys > 0)
      .map((d) => `db${d.i}:keys=${d.keys},expires=${d.expires},avg_ttl=0`),
  };
  const wanted = args.map((a) => a.toLowerCase());
  const all = !wanted.length || wanted.includes('all') || wanted.includes('everything') || wanted.includes('default');
  const out: string[] = [];
  for (const [name, lines] of Object.entries(sections)) {
    if (!all && !wanted.includes(name)) continue;
    out.push(`# ${name[0].toUpperCase()}${name.slice(1)}`, ...lines, '');
  }
  return out.join('\r\n');
}

function config(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const cfg = ctx.server.config;
  if (sub === 'get') {
    if (args.length < 2) throw new CommandError("ERR wrong number of arguments for 'config|get' command");
    const out: string[] = [];
    const seen = new Set<string>();
    for (const pattern of args.slice(1)) {
      const p = ServerConfig.canonical(pattern);
      for (const [k, v] of cfg.entries()) {
        if (seen.has(k) || !matchGlob(p, k)) continue;
        seen.add(k);
        out.push(k, v);
      }
    }
    return RespMap.from(out);
  }
  if (sub === 'set') {
    const pairs = args.slice(1);
    if (!pairs.length || pairs.length % 2) throw new CommandError("ERR wrong number of arguments for 'config|set' command");
    for (let i = 0; i < pairs.length; i += 2) {
      const name = ServerConfig.canonical(pairs[i]);
      if (!cfg.has(name)) throw new CommandError(`ERR Unknown option or number of arguments for CONFIG SET - '${pairs[i]}'`);
      if (['port', 'bind', 'databases'].includes(name)) throw new CommandError(`ERR CONFIG SET failed (possibly related to argument '${pairs[i]}') - can't set immutable config`);
    }
    for (let i = 0; i < pairs.length; i += 2) cfg.set(pairs[i], pairs[i + 1]);
    return OK;
  }
  if (sub === 'resetstat' || sub === 'rewrite') return OK;
  if (sub === 'help') return ['CONFIG <subcommand>'];
  throw new CommandError(unknownSubcommand(args[0], 'config'));
}

/** COMMAND INFO entry: name, arity, flags, first key, last key, step, ACL categories, tips, key specs, subcommands. */
function commandInfo(spec: CommandSpec): Reply {
  const flags = [spec.flags?.write ? 'write' : 'readonly'];
  if (spec.flags?.noscript) flags.push('noscript');
  if (spec.flags?.pubsub) flags.push('pubsub');
  if (spec.flags?.noauth) flags.push('no_auth');
  const hasKeys = Boolean(spec.keys);
  return [spec.name, spec.arity, flags.map((f) => new Status(f)), hasKeys ? 1 : 0, hasKeys ? 1 : 0, hasKeys ? 1 : 0, [], [], [], []];
}

function command(_ctx: CommandContext, args: string[]): Reply {
  const sub = (args[0] ?? '').toLowerCase();
  if (!args.length) return [...COMMANDS.values()].map(commandInfo);
  if (sub === 'count') return COMMANDS.size;
  if (sub === 'list') return [...COMMANDS.keys()];
  if (sub === 'info') {
    const names = args.length > 1 ? args.slice(1) : [...COMMANDS.keys()];
    return names.map((n) => {
      const spec = COMMANDS.get(n.toLowerCase());
      return spec ? commandInfo(spec) : null;
    });
  }
  if (sub === 'docs') return [];
  if (sub === 'getkeys' || sub === 'getkeysandflags') {
    const spec = COMMANDS.get((args[1] ?? '').toLowerCase());
    if (!spec) throw new CommandError('ERR Invalid command specified');
    const keys = spec.keys?.(args.slice(2)) ?? [];
    if (!keys.length) throw new CommandError('ERR The command has no key arguments');
    return sub === 'getkeys' ? keys : keys.map((k) => [k, [new Status(spec.flags?.write ? 'RW' : 'RO')]]);
  }
  if (sub === 'help') return ['COMMAND <subcommand>'];
  throw new CommandError(unknownSubcommand(args[0], 'command'));
}

/** ACL: a single `default` user with every permission (password from --password). */
function acl(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const pass = ctx.server.options.password ? '#<hidden>' : 'nopass';
  switch (sub) {
    case 'whoami':
      return 'default';
    case 'users':
      return ['default'];
    case 'list':
      return [`user default on ${pass} sanitize-payload ~* &* +@all`];
    case 'cat':
      return ['keyspace', 'read', 'write', 'set', 'sortedset', 'list', 'hash', 'string', 'bitmap', 'hyperloglog', 'geo', 'stream', 'pubsub', 'admin', 'fast', 'slow', 'blocking', 'dangerous', 'connection', 'transaction', 'scripting'];
    case 'getuser':
      if (args[1] !== 'default') return null;
      return RespMap.from(['flags', ['on', 'sanitize-payload'], 'passwords', [], 'commands', '+@all', 'keys', '~*', 'channels', '&*', 'selectors', []]);
    case 'dryrun':
      return OK;
    case 'log':
      return args[1]?.toLowerCase() === 'reset' ? OK : [];
    case 'genpass':
      return randomBytes(Math.ceil(Number(args[1] ?? 256) / 8)).toString('hex');
    case 'setuser':
    case 'deluser':
    case 'load':
    case 'save':
      throw new CommandError('ERR ACL users are not supported by redis-lite (single default user only)');
    case 'help':
      return ['ACL <subcommand>'];
    default:
      throw new CommandError(unknownSubcommand(args[0], 'acl'));
  }
}

function flush(ctx: CommandContext, all: boolean): Reply {
  const dbs = all ? ctx.server.databases : [ctx.db];
  for (const db of dbs) db.flush();
  ctx.server.epoch++;
  return OK;
}

export const serverCommands: CommandSpec[] = [
  { name: 'info', arity: -1, handler: (ctx, args) => new RespVerbatim(info(ctx, args)) },
  { name: 'config', arity: -2, flags: { noscript: true }, handler: config },
  {
    name: 'time',
    arity: 1,
    handler: () => {
      const us = BigInt(Date.now()) * 1000n + BigInt(Math.floor((performance.now() % 1) * 1000));
      return [String(us / 1000000n), String(us % 1000000n)];
    },
  },
  { name: 'dbsize', arity: 1, handler: (ctx) => ctx.db.size },
  { name: 'flushdb', arity: -1, flags: { write: true }, handler: (ctx) => flush(ctx, false) },
  { name: 'flushall', arity: -1, flags: { write: true }, handler: (ctx) => flush(ctx, true) },
  { name: 'command', arity: -1, handler: command },
  { name: 'acl', arity: -2, handler: acl },
  {
    name: 'slowlog',
    arity: -2,
    handler: (_ctx, args) => {
      const sub = args[0].toLowerCase();
      if (sub === 'get') return [];
      if (sub === 'len') return 0;
      if (sub === 'reset') return OK;
      if (sub === 'help') return ['SLOWLOG <subcommand>'];
      throw new CommandError(unknownSubcommand(args[0], 'slowlog'));
    },
  },
  {
    name: 'latency',
    arity: -2,
    handler: (_ctx, args) => {
      const sub = args[0].toLowerCase();
      if (sub === 'latest' || sub === 'history' || sub === 'histogram') return [];
      if (sub === 'reset') return 0;
      if (sub === 'doctor') return new RespVerbatim('Dave, no latency spike was observed during the lifetime of this Redis instance, not in the slightest bit.');
      if (sub === 'graph') return '';
      if (sub === 'help') return ['LATENCY <subcommand>'];
      throw new CommandError(unknownSubcommand(args[0], 'latency'));
    },
  },
  {
    name: 'monitor',
    arity: 1,
    flags: { noscript: true },
    handler: (ctx) => {
      if (ctx.client.multi || ctx.noBlock) throw new CommandError('ERR MONITOR is not allowed in this context');
      ctx.client.monitor = true;
      ctx.server.monitors.add(ctx.client);
      return OK;
    },
  },
  {
    name: 'shutdown',
    arity: -1,
    flags: { noscript: true },
    handler: (ctx, args) => {
      if (args.some((a) => a.toLowerCase() === 'abort')) throw new CommandError('ERR No shutdown in progress.');
      setImmediate(() => void ctx.server.close());
      return NO_REPLY;
    },
  },
  { name: 'waitaof', arity: 4, flags: { noscript: true }, handler: () => [0, 0] },
  {
    name: 'lolwut',
    arity: -1,
    handler: () => new RespVerbatim(`redis-lite: a tiny Redis-compatible server. Redis ver. ${REDIS_VERSION}\n`),
  },
  { name: 'save', arity: 1, flags: { noscript: true }, handler: () => OK },
  { name: 'bgsave', arity: -1, flags: { noscript: true }, handler: () => new Status('Background saving started') },
  { name: 'lastsave', arity: 1, handler: (ctx) => Math.floor(ctx.server.startedAt / 1000) },
  { name: 'wait', arity: 3, flags: { noscript: true }, handler: () => 0 },
  { name: 'role', arity: 1, handler: () => ['master', 0, []] },
  {
    name: 'memory',
    arity: -2,
    handler: (ctx, args) => {
      const sub = args[0].toLowerCase();
      if (sub === 'usage') return ctx.db.has(args[1] ?? '') ? 64 : null;
      if (sub === 'doctor') return new RespVerbatim('Sam, I have no memory problems');
      throw new CommandError(unknownSubcommand(args[0], 'memory'));
    },
  },
  {
    name: 'debug',
    arity: -2,
    flags: { noscript: true },
    handler: (_ctx, args) => {
      if (args[0].toLowerCase() === 'sleep') parseInteger(String(Math.trunc(Number(args[1] ?? '0'))));
      return OK;
    },
  },
];
