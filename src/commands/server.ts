import { createHash, randomBytes } from 'node:crypto';
import { arch, release, totalmem, type as osType } from 'node:os';

import { CommandError } from '../errors';
import { RespMessages, unknownSubcommand } from '../messages';
import type { Reply } from '../resp';
import { OK, RespMap, RespSet, RespVerbatim, Status } from '../resp';
import { ServerConfig } from '../server/config';
import type { RedisValue } from '../store/database';
import { matchGlob, parseInteger } from '../util';
import { REDIS_VERSION, defaultPassword, helpReply, subcommandSyntaxError } from './connection';
import type { CommandMeta } from './meta';
import {
  ACL_CATEGORIES, allCommandMeta, allCommandsDeep, arityOk, commandDocsReply, commandHasKeys, commandInfoReply, getCommandMeta, keysFromSpecs,
  lookupCommand,
} from './meta';
import { HELP_TEXT } from './meta-table';
import type { CommandContext, CommandSpec, HandlerResult } from './types';
import { Block, NO_REPLY } from './types';

// ---- INFO ----------------------------------------------------------------------------------------------------------

/** Redis bytesToHuman(). */
function human(n: number): string {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  if (n < 1024) return `${n}B`;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)}${units[i]}`;
}

let peakMemory = 0;

/** Sections in Redis order; `def` = part of the default set. */
const INFO_SECTIONS: Array<[name: string, title: string, def: boolean]> = [
  ['server', 'Server', true],
  ['clients', 'Clients', true],
  ['memory', 'Memory', true],
  ['persistence', 'Persistence', true],
  ['threads', 'Threads', true],
  ['stats', 'Stats', true],
  ['replication', 'Replication', true],
  ['cpu', 'CPU', true],
  ['modules', 'Modules', true],
  ['commandstats', 'Commandstats', false],
  ['errorstats', 'Errorstats', true],
  ['cluster', 'Cluster', true],
  ['keyspace', 'Keyspace', true],
];

function infoSection(ctx: CommandContext, name: string): string[] {
  const s = ctx.server;
  const cfg = s.config;
  const now = Date.now();
  const uptime = Math.floor((now - s.startedAt) / 1000);
  const clients = [...s.clients];
  switch (name) {
    case 'server':
      return [
        `redis_version:${REDIS_VERSION}`,
        'redis_git_sha1:00000000',
        'redis_git_dirty:0',
        'redis_build_id:0',
        'redis_mode:standalone',
        `os:${osType()} ${release()} ${arch()}`,
        'arch_bits:64',
        'monotonic_clock:POSIX clock_gettime',
        'multiplexing_api:epoll',
        'atomicvar_api:c11-builtin',
        'gcc_version:0.0.0',
        `process_id:${process.pid}`,
        'process_supervised:no',
        `run_id:${s.runId}`,
        `tcp_port:${s.options.port}`,
        `server_time_usec:${now * 1000}`,
        `uptime_in_seconds:${uptime}`,
        `uptime_in_days:${Math.floor(uptime / 86400)}`,
        `hz:${cfg.get('hz') ?? '10'}`,
        `configured_hz:${cfg.get('hz') ?? '10'}`,
        `lru_clock:${Math.floor(now / 1000) & 0xffffff}`,
        `executable:${process.argv[1] ?? ''}`,
        'config_file:',
        'io_threads_active:0',
        `listener0:name=tcp,bind=${s.options.host},port=${s.options.port}`,
      ];
    case 'clients': {
      const watchedKeys = clients.reduce((n, c) => n + c.watched.size, 0);
      const blockingKeys = new Set(clients.flatMap((c) => c.blocked?.dbKeys ?? [])).size;
      return [
        `connected_clients:${clients.length}`,
        'cluster_connections:0',
        `maxclients:${cfg.get('maxclients') ?? '10000'}`,
        'client_recent_max_input_buffer:0',
        'client_recent_max_output_buffer:0',
        `blocked_clients:${clients.filter((c) => c.blocked).length}`,
        `tracking_clients:${clients.filter((c) => c.tracking).length}`,
        `pubsub_clients:${clients.filter((c) => c.subscriptionCount > 0).length}`,
        `watching_clients:${clients.filter((c) => c.watched.size > 0).length}`,
        `clients_in_timeout_table:${clients.filter((c) => c.blocked?.timer).length}`,
        `total_watched_keys:${watchedKeys}`,
        `total_blocking_keys:${blockingKeys}`,
        'total_blocking_keys_on_nokey:0',
      ];
    }
    case 'memory': {
      const mem = process.memoryUsage();
      const used = mem.heapUsed;
      peakMemory = Math.max(peakMemory, used);
      const maxmemory = cfg.num('maxmemory');
      const total = totalmem();
      return [
        `used_memory:${used}`,
        `used_memory_human:${human(used)}`,
        `used_memory_rss:${mem.rss}`,
        `used_memory_rss_human:${human(mem.rss)}`,
        `used_memory_peak:${peakMemory}`,
        `used_memory_peak_human:${human(peakMemory)}`,
        `used_memory_peak_perc:${((used / peakMemory) * 100).toFixed(2)}%`,
        `used_memory_lua:${31 * 1024}`,
        `used_memory_scripts:0`,
        `total_system_memory:${total}`,
        `total_system_memory_human:${human(total)}`,
        `maxmemory:${maxmemory}`,
        `maxmemory_human:${human(maxmemory)}`,
        `maxmemory_policy:${cfg.get('maxmemory-policy') ?? 'noeviction'}`,
        `mem_fragmentation_ratio:${(mem.rss / Math.max(used, 1)).toFixed(2)}`,
        'mem_allocator:libc',
        'lazyfree_pending_objects:0',
      ];
    }
    case 'persistence':
      return [
        'loading:0',
        'async_loading:0',
        'current_cow_peak:0',
        'current_cow_size:0',
        'current_cow_size_age:0',
        'current_fork_perc:0.00',
        'current_save_keys_processed:0',
        'current_save_keys_total:0',
        `rdb_changes_since_last_save:${s.dirty}`,
        'rdb_bgsave_in_progress:0',
        `rdb_last_save_time:${Math.floor(s.lastSave / 1000)}`,
        'rdb_last_bgsave_status:ok',
        'rdb_last_bgsave_time_sec:-1',
        'rdb_current_bgsave_time_sec:-1',
        'rdb_saves:0',
        'rdb_last_cow_size:0',
        'rdb_last_load_keys_expired:0',
        'rdb_last_load_keys_loaded:0',
        `aof_enabled:${cfg.get('appendonly') === 'yes' ? 1 : 0}`,
        'aof_rewrite_in_progress:0',
        'aof_rewrite_scheduled:0',
        'aof_last_rewrite_time_sec:-1',
        'aof_current_rewrite_time_sec:-1',
        'aof_last_bgrewrite_status:ok',
        'aof_rewrites:0',
        'aof_rewrites_consecutive_failures:0',
        'aof_last_write_status:ok',
        'aof_last_cow_size:0',
        'module_fork_in_progress:0',
        'module_fork_last_cow_size:0',
      ];
    case 'threads':
      return [`io_thread_0:clients=${clients.length},reads=0,writes=0`];
    case 'stats': {
      const netIn = s.stats.netIn + clients.reduce((n, c) => n + c.netIn, 0);
      const netOut = s.stats.netOut + clients.reduce((n, c) => n + c.netOut, 0);
      return [
        `total_connections_received:${s.stats.connections}`,
        `total_commands_processed:${s.stats.commands}`,
        'instantaneous_ops_per_sec:0',
        `total_net_input_bytes:${netIn}`,
        `total_net_output_bytes:${netOut}`,
        'total_net_repl_input_bytes:0',
        'total_net_repl_output_bytes:0',
        'instantaneous_input_kbps:0.00',
        'instantaneous_output_kbps:0.00',
        'instantaneous_input_repl_kbps:0.00',
        'instantaneous_output_repl_kbps:0.00',
        'rejected_connections:0',
        'sync_full:0',
        'sync_partial_ok:0',
        'sync_partial_err:0',
        `expired_keys:${s.stats.expired}`,
        'expired_stale_perc:0.00',
        'expired_time_cap_reached_count:0',
        'expire_cycle_cpu_milliseconds:0',
        'evicted_keys:0',
        'evicted_clients:0',
        'evicted_scripts:0',
        'total_eviction_exceeded_time:0',
        'current_eviction_exceeded_time:0',
        'keyspace_hits:0',
        'keyspace_misses:0',
        `pubsub_channels:${s.channels.size}`,
        `pubsub_patterns:${s.patterns.size}`,
        `pubsubshard_channels:${s.shardChannels.size}`,
        'latest_fork_usec:0',
        'total_forks:0',
        'migrate_cached_sockets:0',
        'slave_expires_tracked_keys:0',
        'active_defrag_hits:0',
        'active_defrag_misses:0',
        'active_defrag_key_hits:0',
        'active_defrag_key_misses:0',
        'total_active_defrag_time:0',
        'current_active_defrag_time:0',
        'tracking_total_keys:0',
        'tracking_total_items:0',
        'tracking_total_prefixes:0',
        'unexpected_error_replies:0',
        `total_error_replies:${s.stats.errorReplies}`,
        'dump_payload_sanitizations:0',
        'total_reads_processed:0',
        'total_writes_processed:0',
        'io_threaded_reads_processed:0',
        'io_threaded_writes_processed:0',
        'client_query_buffer_limit_disconnections:0',
        'client_output_buffer_limit_disconnections:0',
        'reply_buffer_shrinks:0',
        'reply_buffer_expands:0',
        'acl_access_denied_auth:0',
        'acl_access_denied_cmd:0',
        'acl_access_denied_key:0',
        'acl_access_denied_channel:0',
      ];
    }
    case 'replication':
      return [
        'role:master',
        'connected_slaves:0',
        'master_failover_state:no-failover',
        `master_replid:${s.runId}`,
        'master_replid2:0000000000000000000000000000000000000000',
        'master_repl_offset:0',
        'second_repl_offset:-1',
        'repl_backlog_active:0',
        `repl_backlog_size:${cfg.get('repl-backlog-size') ?? '1048576'}`,
        'repl_backlog_first_byte_offset:0',
        'repl_backlog_histlen:0',
      ];
    case 'cpu': {
      const cpu = process.cpuUsage();
      const sys = (cpu.system / 1e6).toFixed(6);
      const user = (cpu.user / 1e6).toFixed(6);
      return [
        `used_cpu_sys:${sys}`,
        `used_cpu_user:${user}`,
        'used_cpu_sys_children:0.000000',
        'used_cpu_user_children:0.000000',
        `used_cpu_sys_main_thread:${sys}`,
        `used_cpu_user_main_thread:${user}`,
      ];
    }
    case 'modules':
      return [];
    case 'commandstats':
      return [...s.commandStats.entries()]
        .filter(([, st]) => st.calls || st.rejected || st.failed)
        .map(
          ([cmd, st]) =>
            `cmdstat_${cmd}:calls=${st.calls},usec=${st.usec},usec_per_call=${(st.calls ? st.usec / st.calls : 0).toFixed(2)},` +
            `rejected_calls=${st.rejected},failed_calls=${st.failed}`,
        );
    case 'errorstats':
      return [...s.errorStats.entries()].map(([code, count]) => `errorstat_${code}:count=${count}`);
    case 'cluster':
      return ['cluster_enabled:0'];
    case 'keyspace':
      return s.databases.flatMap((db, i) => {
        const keys = db.keys();
        if (!keys.length) return [];
        let expires = 0;
        let ttlSum = 0;
        for (const k of keys) {
          const at = db.getExpire(k);
          if (at === undefined) continue;
          expires++;
          ttlSum += Math.max(0, at - now);
        }
        return [`db${i}:keys=${keys.length},expires=${expires},avg_ttl=${expires ? Math.floor(ttlSum / expires) : 0},subexpiry=0`];
      });
    default:
      return [];
  }
}

function info(ctx: CommandContext, args: string[]): string {
  const wanted = new Set(args.map((a) => a.toLowerCase()));
  const everything = wanted.has('all') || wanted.has('everything');
  const def = !wanted.size || wanted.has('default');
  const out: string[] = [];
  for (const [name, title, isDefault] of INFO_SECTIONS) {
    if (!(everything || wanted.has(name) || (def && isDefault))) continue;
    out.push(`# ${title}\r\n${infoSection(ctx, name).map((l) => `${l}\r\n`).join('')}`);
  }
  return out.join('\r\n');
}

// ---- CONFIG --------------------------------------------------------------------------------------------------------

function configGet(ctx: CommandContext, patterns: string[]): Reply {
  const cfg = ctx.server.config;
  const matched = new Map<string, string>();
  const seen = new Set<string>();
  for (const pattern of patterns) {
    if (!/[*?[]/.test(pattern)) {
      const canonical = ServerConfig.canonical(pattern);
      if (seen.has(canonical) || !cfg.has(canonical)) continue;
      seen.add(canonical);
      matched.set(pattern.toLowerCase(), cfg.get(canonical) ?? '');
      continue;
    }
    for (const name of ServerConfig.allNames()) {
      const canonical = ServerConfig.canonical(name);
      if (seen.has(canonical) || !cfg.has(canonical) || !matchGlob(pattern.toLowerCase(), name)) continue;
      seen.add(canonical);
      matched.set(name, cfg.get(canonical) ?? '');
    }
  }
  return new RespMap([...matched.entries()]);
}

function configSet(ctx: CommandContext, pairs: string[]): Reply {
  const cfg = ctx.server.config;
  if (pairs.length % 2) throw new CommandError("ERR wrong number of arguments for 'config|set' command");
  let unknown: string | null = null;
  let failure: [string, string] | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < pairs.length; i += 2) {
    const canonical = ServerConfig.canonical(pairs[i]);
    if (!cfg.has(canonical)) {
      unknown ??= pairs[i];
      continue;
    }
    if (unknown !== null || failure) continue;
    if (cfg.isImmutable(canonical)) failure = [pairs[i], "can't set immutable config"];
    else if (seen.has(canonical)) failure = [pairs[i], 'duplicate parameter'];
    seen.add(canonical);
  }
  if (unknown !== null) throw new CommandError(`ERR Unknown option or number of arguments for CONFIG SET - '${unknown}'`);
  const values: Array<[string, string]> = [];
  if (!failure) {
    for (let i = 0; i < pairs.length; i += 2) {
      const r = cfg.validate(pairs[i], pairs[i + 1]);
      if ('error' in r) {
        failure = [pairs[i], r.error];
        break;
      }
      values.push([pairs[i], r.value]);
    }
  }
  if (failure) throw new CommandError(`ERR CONFIG SET failed (possibly related to argument '${failure[0]}') - ${failure[1]}`);
  for (const [name, value] of values) cfg.set(name, value);
  return OK;
}

function config(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  switch (sub) {
    case 'get':
      return configGet(ctx, args.slice(1));
    case 'set':
      return configSet(ctx, args.slice(1));
    case 'resetstat':
      ctx.server.resetStats();
      return OK;
    case 'rewrite':
      throw new CommandError('ERR The server is running without a config file');
    case 'help':
      return helpReply('config', HELP_TEXT.config);
    default:
      throw new CommandError(unknownSubcommand(args[0], 'config'));
  }
}

// ---- COMMAND -------------------------------------------------------------------------------------------------------

function commandGetKeys(args: string[], withFlags: boolean): Reply {
  const argv = args.slice(1);
  const { meta } = lookupCommand(argv);
  if (!meta) throw new CommandError('ERR Invalid command specified');
  if (!commandHasKeys(meta)) throw new CommandError('ERR The command has no key arguments');
  if (!arityOk(meta.arity, argv.length)) throw new CommandError('ERR Invalid number of arguments specified for command');
  const keys = keysFromSpecs(meta, argv);
  if (!keys?.length) {
    if (meta.flagSet.has('no_mandatory_keys')) return [];
    throw new CommandError('ERR Invalid arguments specified for command');
  }
  return withFlags ? keys.map((k) => [argv[k.index], new RespSet(k.flags.map((f) => new Status(f)))]) : keys.map((k) => argv[k.index]);
}

function commandList(args: string[]): Reply {
  const all = allCommandsDeep();
  if (args.length === 1) return all.map((m) => m.fullname);
  if (args.length !== 4 || args[1].toLowerCase() !== 'filterby') throw new CommandError(RespMessages.SYNTAX);
  const kind = args[2].toLowerCase();
  const value = args[3];
  let filter: (m: CommandMeta) => boolean;
  if (kind === 'module') filter = () => false;
  else if (kind === 'aclcat') filter = (m) => m.acl.includes(value.toLowerCase());
  else if (kind === 'pattern') filter = (m) => matchGlob(value.toLowerCase(), m.fullname);
  else throw new CommandError(RespMessages.SYNTAX);
  return all.filter(filter).map((m) => m.fullname);
}

function command(_ctx: CommandContext, args: string[]): Reply {
  if (!args.length) return allCommandMeta().map(commandInfoReply);
  const sub = args[0].toLowerCase();
  switch (sub) {
    case 'count':
      return allCommandMeta().length;
    case 'list':
      return commandList(args);
    case 'info': {
      const metas = args.length > 1 ? args.slice(1).map((n) => getCommandMeta(n)) : allCommandMeta();
      return metas.map((m) => (m ? commandInfoReply(m) : null));
    }
    case 'docs': {
      const metas = args.length > 1 ? args.slice(1).map((n) => getCommandMeta(n)) : allCommandMeta();
      return new RespMap(metas.filter((m): m is CommandMeta => Boolean(m)).map((m) => [m.fullname, commandDocsReply(m)]));
    }
    case 'getkeys':
      return commandGetKeys(args, false);
    case 'getkeysandflags':
      return commandGetKeys(args, true);
    case 'help':
      return helpReply('command', HELP_TEXT.command);
    default:
      throw new CommandError(unknownSubcommand(args[0], 'command'));
  }
}

// ---- ACL -----------------------------------------------------------------------------------------------------------

const NO_ACL_FILE =
  'ERR This Redis instance is not configured to use an ACL file. You may want to specify users via the ACL SETUSER command and then issue a CONFIG REWRITE (assuming you have a Redis configuration file set) in order to store users in the Redis configuration.';

/** ACL: a single `default` user with every permission (nopass unless requirepass is set). */
function acl(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const password = defaultPassword(ctx);
  const hash = password ? createHash('sha256').update(Buffer.from(password, 'latin1')).digest('hex') : '';
  switch (sub) {
    case 'whoami':
      return 'default';
    case 'users':
      return ['default'];
    case 'list':
      return [password ? `user default on sanitize-payload #${hash} ~* &* +@all` : 'user default on nopass sanitize-payload ~* &* +@all'];
    case 'cat': {
      if (args.length === 1) return [...ACL_CATEGORIES];
      if (args.length > 2) throw subcommandSyntaxError(args[0], 'acl');
      const cat = args[1].toLowerCase();
      if (!(ACL_CATEGORIES as readonly string[]).includes(cat)) throw new CommandError(`ERR Unknown category '${args[1].slice(0, 128)}'`);
      return allCommandsDeep()
        .filter((m) => m.acl.includes(cat))
        .map((m) => m.fullname);
    }
    case 'getuser':
      if (args[1] !== 'default') return null;
      return RespMap.from([
        'flags', new RespSet(password ? ['on', 'sanitize-payload'] : ['on', 'nopass', 'sanitize-payload']),
        'passwords', password ? [hash] : [],
        'commands', '+@all',
        'keys', '~*',
        'channels', '&*',
        'selectors', [],
      ]);
    case 'dryrun': {
      if (args[1] !== 'default') throw new CommandError(`ERR User '${args[1]}' not found`);
      const argv = args.slice(2);
      const { meta } = lookupCommand(argv);
      if (!meta) throw new CommandError(`ERR Command '${argv[0]}' not found`);
      if (!arityOk(meta.arity, argv.length)) throw new CommandError(`ERR wrong number of arguments for '${meta.fullname}' command`);
      return OK;
    }
    case 'log':
      if (args.length > 2) throw subcommandSyntaxError(args[0], 'acl');
      if (args.length === 2 && args[1].toLowerCase() === 'reset') return OK;
      if (args.length === 2) parseInteger(args[1]);
      return [];
    case 'genpass': {
      const bits = args.length > 1 ? parseInteger(args[1]) : 256;
      if (bits <= 0 || bits > 4096)
        throw new CommandError('ERR ACL GENPASS argument must be the number of bits for the output password, a positive number up to 4096');
      const chars = Math.floor((bits + 3) / 4);
      return randomBytes(Math.ceil(chars / 2)).toString('hex').slice(0, chars);
    }
    case 'deluser':
      if (args.slice(1).includes('default')) throw new CommandError("ERR The 'default' user cannot be removed");
      return 0;
    case 'load':
    case 'save':
      throw new CommandError(NO_ACL_FILE);
    case 'setuser':
      throw new CommandError('ERR ACL users are not supported by redis-lite (single default user only)');
    case 'help':
      return helpReply('acl', HELP_TEXT.acl);
    default:
      throw new CommandError(unknownSubcommand(args[0], 'acl'));
  }
}

// ---- FLUSHDB / FLUSHALL / SAVE -------------------------------------------------------------------------------------

function flush(ctx: CommandContext, args: string[], all: boolean): Reply {
  if (args.length > 1) throw new CommandError(RespMessages.SYNTAX);
  if (args.length === 1 && !['async', 'sync'].includes(args[0].toLowerCase())) throw new CommandError(RespMessages.SYNTAX);
  const s = ctx.server;
  const indexes = all ? s.databases.map((_, i) => i) : [ctx.client.dbIndex];
  for (const i of indexes) {
    s.dirty += s.databases[i].keys().length;
    s.signalFlushedDb(i);
    s.databases[i].flush();
  }
  // FLUSHALL saves right away when save points are configured, like Redis
  if (all && (s.config.get('save') ?? '') !== '') {
    s.lastSave = Date.now();
    s.dirty = 0;
  }
  return OK;
}

// ---- SLOWLOG / LATENCY / MEMORY ------------------------------------------------------------------------------------

function slowlog(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const s = ctx.server;
  switch (sub) {
    case 'get': {
      if (args.length > 2) throw subcommandSyntaxError(args[0], 'slowlog');
      let count = 10;
      if (args.length === 2) {
        const msg = 'ERR count should be greater than or equal to -1';
        count = parseInteger(args[1], msg);
        if (count < -1) throw new CommandError(msg);
        if (count === -1) count = s.slowlog.length;
      }
      return s.slowlog.slice(0, count).map((e) => [e.id, e.time, e.usec, e.argv, e.addr, e.name]);
    }
    case 'len':
      return s.slowlog.length;
    case 'reset':
      s.slowlogReset();
      return OK;
    case 'help':
      return helpReply('slowlog', HELP_TEXT.slowlog);
    default:
      throw new CommandError(unknownSubcommand(args[0], 'slowlog'));
  }
}

function latency(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  switch (sub) {
    case 'latest':
      return [];
    case 'history':
      return [];
    case 'reset':
      return 0;
    case 'graph':
      throw new CommandError(`ERR No samples available for event '${args[1]}'`);
    case 'histogram':
      return new RespMap([]);
    case 'doctor':
      return new RespVerbatim(
        ctx.server.config.num('latency-monitor-threshold') === 0
          ? 'I\'m sorry, Dave, I can\'t do that. Latency monitoring is disabled in this Redis instance. You may use "CONFIG SET latency-monitor-threshold <milliseconds>." in order to enable it. If we weren\'t in a deep space mission I\'d suggest to take a look at https://redis.io/topics/latency-monitor.\n'
          : 'Dave, no latency spike was observed during the lifetime of this Redis instance, not in the slightest bit. I honestly think you ought to sleep tonight.\n',
      );
    case 'help':
      return helpReply('latency', HELP_TEXT.latency);
    default:
      throw new CommandError(unknownSubcommand(args[0], 'latency'));
  }
}

/** Rough MEMORY USAGE estimate (dictEntry + key sds + robj + value), in the spirit of objectComputeSize(). */
function memoryUsage(key: string, v: RedisValue, samples: number): number {
  const sds = (s: string): number => s.length + (s.length < 32 ? 2 : s.length < 256 ? 3 : 5);
  const sample = <T>(items: Iterable<T>, size: number, cost: (item: T) => number): number => {
    let n = 0;
    let sum = 0;
    for (const item of items) {
      if (n >= samples) break;
      sum += cost(item);
      n++;
    }
    return n ? Math.round((sum / n) * size) : 0;
  };
  let value: number;
  switch (v.type) {
    case 'string':
      value = /^-?\d{1,19}$/.test(v.value) && v.value.length < 20 ? 0 : sds(v.value);
      break;
    case 'hash':
      value = 64 + sample(v.value.entries(), v.value.size, ([f, x]) => sds(f) + sds(x) + 24);
      break;
    case 'list':
      value = 48 + sample(v.value, v.value.length, (x) => x.length + 2);
      break;
    case 'set':
      value = 64 + sample(v.value, v.value.size, (x) => sds(x) + 24);
      break;
    case 'zset':
      value = 96 + v.value.size * 48;
      break;
    case 'stream':
      value = 256 + v.value.length * 32;
      break;
  }
  return 24 + sds(key) + 16 + value;
}

function memory(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  switch (sub) {
    case 'usage': {
      let samples = 5;
      for (let j = 2; j < args.length; j++) {
        if (args[j].toLowerCase() === 'samples' && j + 1 < args.length) {
          samples = parseInteger(args[j + 1]);
          if (samples < 0) throw new CommandError(RespMessages.SYNTAX);
          if (samples === 0) samples = Number.MAX_SAFE_INTEGER;
          j++;
        } else throw new CommandError(RespMessages.SYNTAX);
      }
      const v = ctx.db.peek(args[1]);
      return v ? memoryUsage(args[1], v, samples) : null;
    }
    case 'doctor': {
      const empty = ctx.server.databases.every((db) => db.keys().length === 0);
      return new RespVerbatim(
        empty
          ? "Hi Sam, this instance is empty or is using very little memory, my issues detector can't be used in these conditions. Please, leave for your mission on Earth and fill it with some data. The new Sam and I will be back to our programming as soon as I finished rebooting."
          : "Hi Sam, I can't find any memory issue in your instance. I can only account for what occurs on this base.",
      );
    }
    case 'stats': {
      const mem = process.memoryUsage();
      const keys = ctx.server.databases.reduce((n, db) => n + db.keys().length, 0);
      return RespMap.from([
        'peak.allocated', Math.max(peakMemory, mem.heapUsed),
        'total.allocated', mem.heapUsed,
        'startup.allocated', 0,
        'replication.backlog', 0,
        'clients.slaves', 0,
        'clients.normal', ctx.server.clients.size * 1024,
        'cluster.links', 0,
        'aof.buffer', 0,
        'lua.caches', 0,
        'functions.caches', 0,
        'overhead.total', 0,
        'keys.count', keys,
        'keys.bytes-per-key', keys ? Math.floor(mem.heapUsed / keys) : 0,
        'dataset.bytes', mem.heapUsed,
        'dataset.percentage', '100',
        'peak.percentage', '100',
        'fragmentation', (mem.rss / Math.max(mem.heapUsed, 1)).toFixed(2),
      ]);
    }
    case 'malloc-stats':
      return 'Stats not supported for the current allocator';
    case 'purge':
      return OK;
    case 'help':
      return helpReply('memory', HELP_TEXT.memory);
    default:
      throw new CommandError(unknownSubcommand(args[0], 'memory'));
  }
}

// ---- WAIT / WAITAOF ------------------------------------------------------------------------------------------------

function parseTimeoutMs(raw: string): number {
  const ms = parseInteger(raw, 'ERR timeout is not an integer or out of range');
  if (ms < 0) throw new CommandError(RespMessages.TIMEOUT_NEGATIVE);
  return ms;
}

/** No replicas ever acknowledge: answers at once when nothing is required, otherwise after the timeout (0 = forever), like Redis. */
function waitFor(ctx: CommandContext, required: boolean, timeoutMs: number, reply: Reply): HandlerResult {
  if (!required || ctx.noBlock) return reply;
  return new Block([], timeoutMs, () => undefined, reply);
}

// ---- LOLWUT --------------------------------------------------------------------------------------------------------

/** LOLWUT VERSION 5: Georg Nees' "Schotter" rendered with braille characters (Redis lolwut5.c). */
function lolwut5(cols: number, perRow: number, perCol: number): string {
  const width = cols * 2;
  const padding = width > 4 ? 2 : 0;
  const side = (width - padding * 2) / perRow;
  const height = Math.trunc(side * perCol + padding * 2);
  const pixels = new Uint8Array(width * height);
  const set = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) pixels[x + y * width] = 1;
  };
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      set(x1, y1);
      if (x1 === x2 && y1 === y2) break;
      const e2 = err * 2;
      if (e2 > -dy) {
        err -= dy;
        x1 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y1 += sy;
      }
    }
  };
  for (let y = 0; y < perCol; y++) {
    for (let x = 0; x < perRow; x++) {
      let sx = Math.trunc(x * side + side / 2 + padding);
      let sy = Math.trunc(y * side + side / 2 + padding);
      let angle = 0;
      if (y > 1) {
        const r = () => (Math.random() / perCol) * y * (Math.random() < 0.5 ? -1 : 1);
        angle = r();
        sx += Math.trunc((r() * side) / 3);
        sy += Math.trunc((r() * side) / 3);
      }
      const size = Math.round(side / 1.4142135623);
      const px: number[] = [];
      const py: number[] = [];
      let k = Math.PI / 4 + angle;
      for (let j = 0; j < 4; j++) {
        px.push(Math.round(Math.sin(k) * size + sx));
        py.push(Math.round(Math.cos(k) * size + sy));
        k += Math.PI / 2;
      }
      for (let j = 0; j < 4; j++) line(px[j], py[j], px[(j + 1) % 4], py[(j + 1) % 4]);
    }
  }
  const get = (x: number, y: number): number => (x < width && y < height ? pixels[x + y * width] : 0);
  const rows: string[] = [];
  for (let y = 0; y < height; y += 4) {
    let row = '';
    for (let x = 0; x < width; x += 2) {
      const byte =
        get(x, y) | (get(x, y + 1) << 1) | (get(x, y + 2) << 2) | (get(x + 1, y) << 3) | (get(x + 1, y + 1) << 4) | (get(x + 1, y + 2) << 5) |
        (get(x, y + 3) << 6) | (get(x + 1, y + 3) << 7);
      row += String.fromCodePoint(0x2800 + byte);
    }
    rows.push(row);
  }
  return rows.join('\n');
}

function lolwut(args: string[]): Reply {
  let version = Number(REDIS_VERSION.split('.')[0]);
  let rest = args;
  if (args.length >= 2 && args[0].toLowerCase() === 'version') {
    version = parseInteger(args[1]);
    rest = args.slice(2);
  }
  let text: string;
  if (version === 5) {
    const clamp = (raw: string | undefined, def: number, max: number) => (raw === undefined ? def : Math.min(Math.max(parseInteger(raw), 1), max));
    const cols = clamp(rest[0], 66, 1000);
    const perRow = clamp(rest[1], 8, 200);
    const perCol = clamp(rest[2], 12, 200);
    text = `${lolwut5(cols, perRow, perCol)}\nGeorg Nees - schotter, plotter on paper, 1968. Redis ver. ${REDIS_VERSION}\n`;
  } else if (version === 6) {
    // the LOLWUT 6 skyline drawing is not reproduced, only its caption
    text = `Dedicated to the 8 bit game developers of past and present.\nOriginal 8 bit image from Plaguemon by hikikomori. Redis ver. ${REDIS_VERSION}\n`;
  } else text = `Redis ver. ${REDIS_VERSION}\n`;
  return new RespVerbatim(Buffer.from(text, 'utf8').toString('latin1'));
}

// ---- DEBUG ---------------------------------------------------------------------------------------------------------

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** DEBUG SLEEP blocks the whole server, as in Redis. */
function blockingSleep(ms: number): void {
  if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms);
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
  { name: 'flushdb', arity: -1, flags: { write: true }, handler: (ctx, args) => flush(ctx, args, false) },
  { name: 'flushall', arity: -1, flags: { write: true }, handler: (ctx, args) => flush(ctx, args, true) },
  { name: 'command', arity: -1, handler: command },
  { name: 'acl', arity: -2, handler: acl },
  { name: 'slowlog', arity: -2, handler: slowlog },
  { name: 'latency', arity: -2, handler: latency },
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
  {
    name: 'waitaof',
    arity: 4,
    flags: { noscript: true },
    handler: (ctx, args) => {
      const timeout = parseTimeoutMs(args[2]);
      const numlocal = parseInteger(args[0]);
      if (numlocal < 0) throw new CommandError(RespMessages.COUNT_POSITIVE);
      const numreplicas = parseInteger(args[1]);
      if (numreplicas < 0) throw new CommandError(RespMessages.COUNT_POSITIVE);
      if (numlocal && ctx.server.config.get('appendonly') !== 'yes')
        throw new CommandError('ERR WAITAOF cannot be used when numlocal is set but appendonly is disabled.');
      return waitFor(ctx, numreplicas > 0, timeout, [numlocal ? 1 : 0, 0]);
    },
  },
  { name: 'lolwut', arity: -1, handler: (_ctx, args) => lolwut(args) },
  {
    name: 'save',
    arity: 1,
    flags: { noscript: true },
    handler: (ctx) => {
      ctx.server.lastSave = Date.now();
      ctx.server.dirty = 0;
      return OK;
    },
  },
  {
    name: 'bgsave',
    arity: -1,
    flags: { noscript: true },
    handler: (ctx, args) => {
      if (args.length > 1 || (args.length === 1 && args[0].toLowerCase() !== 'schedule')) throw new CommandError(RespMessages.SYNTAX);
      ctx.server.lastSave = Date.now();
      ctx.server.dirty = 0;
      return new Status('Background saving started');
    },
  },
  { name: 'lastsave', arity: 1, handler: (ctx) => Math.floor(ctx.server.lastSave / 1000) },
  {
    name: 'wait',
    arity: 3,
    flags: { noscript: true },
    handler: (ctx, args) => {
      const timeout = parseTimeoutMs(args[1]);
      const numreplicas = parseInteger(args[0]);
      return waitFor(ctx, numreplicas > 0, timeout, 0);
    },
  },
  { name: 'role', arity: 1, handler: () => ['master', 0, []] },
  { name: 'memory', arity: -2, handler: memory },
  {
    name: 'debug',
    arity: -2,
    flags: { noscript: true },
    handler: (_ctx, args) => {
      if (args[0].toLowerCase() === 'sleep') {
        // Redis: strtod(), no validation
        const seconds = Number.parseFloat(args[1] ?? '0');
        blockingSleep(Number.isFinite(seconds) ? seconds * 1000 : 0);
      }
      return OK;
    },
  },
];
