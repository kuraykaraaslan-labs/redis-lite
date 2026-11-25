import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { arch, release, totalmem, type as osType } from 'node:os';

import { CommandError } from '../errors';
import { RespMessages, unknownSubcommand } from '../messages';
import type { Reply } from '../resp';
import { OK, RespDouble, RespMap, RespSet, RespVerbatim, Status } from '../resp';
import { ACL_MESSAGES, aclDenialMessage, genPass } from '../server/acl';
import { ServerConfig } from '../server/config';
import { resolveDir } from '../server/server';
import type { RedisValue } from '../store/database';
import { objectEncoding } from '../store/encoding';
import { debugQuicklistInfo, infoMemory, memoryStats, memoryUsage, serializedLength } from '../store/memory';
import type { MemoryReport, MemoryStatValue } from '../store/memory';
import { matchGlob, parseInteger } from '../util';
import { REDIS_VERSION, helpReply, subcommandSyntaxError } from './connection';
import { hashFieldExpires } from './hashes';
import { rdbOptions } from './keys-extra';
import type { CommandMeta } from './meta';
import {
  allCommandMeta, allCommandsDeep, arityOk, commandDocsReply, commandHasKeys, commandInfoReply, getCommandMeta, keysFromSpecs, lookupCommand,
} from './meta';
import { HELP_TEXT } from './meta-table';
import type { CommandContext, CommandSpec, HandlerResult } from './types';
import { Block, NO_REPLY } from './types';

// ---- INFO ----------------------------------------------------------------------------------------------------------

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
        `config_file:${s.options.configFile ?? ''}`,
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
      const report = s.memoryReport();
      return infoMemory(report, {
        peakTime: s.memoryPeakTime,
        totalSystemMemory: totalmem(),
        cachedScripts: s.scripts.size,
        maxmemory: cfg.num('maxmemory'),
        maxmemoryPolicy: cfg.get('maxmemory-policy') ?? 'noeviction',
      }).map(([k, v]) => `${k}:${v}`);
    }
    case 'persistence':
      return s.persistence.info();
    case 'threads':
      return [`io_thread_0:clients=${clients.length},reads=0,writes=0`];
    case 'stats': {
      const netIn = s.stats.netIn + clients.reduce((n, c) => n + c.netIn, 0);
      const netOut = s.stats.netOut + clients.reduce((n, c) => n + c.netOut, 0);
      const exceeded = s.evictor.exceededTime(now);
      const tracking = s.tracking.stats();
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
        `evicted_keys:${s.evictor.evictedKeys}`,
        'evicted_clients:0',
        'evicted_scripts:0',
        `total_eviction_exceeded_time:${exceeded.total}`,
        `current_eviction_exceeded_time:${exceeded.current}`,
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
        `tracking_total_keys:${tracking.keys}`,
        `tracking_total_items:${tracking.items}`,
        `tracking_total_prefixes:${tracking.prefixes}`,
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
        `acl_access_denied_auth:${s.aclStats.auth}`,
        `acl_access_denied_cmd:${s.aclStats.command}`,
        `acl_access_denied_key:${s.aclStats.key}`,
        `acl_access_denied_channel:${s.aclStats.channel}`,
      ];
    }
    case 'replication':
      return [
        'role:master',
        'connected_slaves:0',
        'master_failover_state:no-failover',
        `master_replid:${s.replId}`,
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
  if (!failure) {
    for (const entry of values) {
      if (ServerConfig.canonical(entry[0]) !== 'dir') continue;
      const dir = resolveDir(entry[1]);
      if ('error' in dir) {
        failure = [entry[0], dir.error];
        break;
      }
      entry[1] = dir.path;
    }
  }
  if (failure) throw new CommandError(`ERR CONFIG SET failed (possibly related to argument '${failure[0]}') - ${failure[1]}`);
  const previous = values.map(([name]) => [name, cfg.get(name) ?? ''] as const);
  const apply = (list: ReadonlyArray<readonly [string, string]>) => {
    for (const [name, value] of list) {
      cfg.set(name, value);
      ctx.server.applyConfig(name, value);
    }
  };
  apply(values);
  // settings with side effects outside the config table (appendonly starts / stops the AOF)
  for (const [name] of values) {
    const reason = ctx.server.persistence.onConfigChange(ServerConfig.canonical(name));
    if (reason !== null) {
      apply(previous);
      throw new CommandError(`ERR CONFIG SET failed (possibly related to argument '${name}') - ${reason}`);
    }
  }
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

/** ACL SAVE: write a temp file and rename it over the ACL file (ACLSaveToFile). */
function aclSave(ctx: CommandContext, file: string): Reply {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, Buffer.from(ctx.server.acl.toFile(), 'latin1'));
    renameSync(tmp, file);
  } catch (e) {
    ctx.server.log('warn', `Saving ACL file: ${(e as Error).message}`);
    throw new CommandError('ERR There was an error trying to save the ACLs. Please check the server logs for more information');
  }
  return OK;
}

/** ACL (aclCommand in acl.c). */
function acl(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const argc = args.length + 1;
  const s = ctx.server;
  const engine = s.acl;
  if (sub === 'setuser' && argc >= 3) {
    engine.setUser(args[1], args.slice(2));
    const u = engine.user(args[1]);
    if (u) s.killRevokedSubscribers(u, ctx.client);
    return OK;
  }
  if (sub === 'deluser' && argc >= 3) {
    const names = args.slice(1);
    if (names.includes('default')) throw new CommandError(ACL_MESSAGES.DEFAULT_UNDELETABLE);
    const users = [...new Set(names)].map((n) => engine.user(n)).filter((u) => u !== undefined);
    const deleted = engine.deleteUser(names);
    for (const u of users) s.killUserClients(u, ctx.client);
    return deleted;
  }
  if (sub === 'getuser' && argc === 3) return engine.getUserReply(args[1]);
  if (sub === 'list' && argc === 2) return engine.list();
  if (sub === 'users' && argc === 2) return engine.users();
  if (sub === 'whoami' && argc === 2) return ctx.client.user ? ctx.client.user.name : null;
  const aclfile = s.config.get('aclfile') ?? '';
  if (!aclfile && (sub === 'load' || sub === 'save')) throw new CommandError(NO_ACL_FILE);
  if (sub === 'load' && argc === 2) {
    s.loadAclFile(aclfile, ctx.client);
    return OK;
  }
  if (sub === 'save' && argc === 2) return aclSave(ctx, aclfile);
  if (sub === 'cat' && argc === 2) return engine.categories();
  if (sub === 'cat' && argc === 3) return engine.commandsInCategory(args[1]);
  if (sub === 'log' && (argc === 2 || argc === 3)) {
    let count = 10;
    if (argc === 3) {
      if (args[1].toLowerCase() === 'reset') {
        engine.resetLog();
        return OK;
      }
      count = Math.max(0, parseInteger(args[1]));
    }
    return engine.logReply(count);
  }
  if (sub === 'dryrun' && argc >= 4) {
    const user = engine.user(args[1]);
    if (!user) throw new CommandError(ACL_MESSAGES.userNotFound(args[1]));
    const argv = args.slice(2);
    const { meta } = lookupCommand(argv);
    if (!meta) throw new CommandError(ACL_MESSAGES.commandNotFound(argv[0]));
    if (!arityOk(meta.arity, argv.length)) throw new CommandError(`ERR wrong number of arguments for '${meta.fullname}' command`);
    const denial = s.aclCheckUser(user, argv, meta);
    return denial ? aclDenialMessage(denial, user.name, true) : OK;
  }
  if (sub === 'genpass' && (argc === 2 || argc === 3)) return genPass(argc === 3 ? parseInteger(args[1]) : 256);
  if (sub === 'help' && argc === 2) return helpReply('acl', HELP_TEXT.acl);
  throw subcommandSyntaxError(args[0], 'acl');
}

// ---- FLUSHDB / FLUSHALL / SAVE -------------------------------------------------------------------------------------

function flush(ctx: CommandContext, args: string[], all: boolean): Reply {
  if (args.length > 1) throw new CommandError(RespMessages.SYNTAX);
  if (args.length === 1 && !['async', 'sync'].includes(args[0].toLowerCase())) throw new CommandError(RespMessages.SYNTAX);
  const s = ctx.server;
  s.flushDatabases(all ? s.databases.map((_, i) => i) : [ctx.client.dbIndex], all);
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

/** Options of the memory model that follow the live config. */
function memoryOpts(ctx: CommandContext, key: string, v: RedisValue, samples: number) {
  const cfg = ctx.server.config;
  return {
    samples,
    hasExpire: ctx.db.getExpire(key) !== undefined,
    fieldTtls: v.type === 'hash' ? hashFieldExpires(v.value) : undefined,
    listMaxListpackSize: cfg.num('list-max-listpack-size'),
    streamNodeMaxEntries: cfg.num('stream-node-max-entries'),
    streamNodeMaxBytes: cfg.num('stream-node-max-bytes'),
  };
}

function encodingOf(ctx: CommandContext, v: RedisValue): string {
  return objectEncoding(v, ctx.server.config, v.type === 'hash' && hashFieldExpires(v.value) !== undefined);
}

function statValue(v: MemoryStatValue): Reply {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return new RespMap(v.map(([k, n]) => [k, n]));
  return new RespDouble(v.double);
}

const DOCTOR_EMPTY =
  "Hi Sam, this instance is empty or is using very little memory, my issues detector can't be used in these conditions. Please, leave for your mission on Earth and fill it with some data. The new Sam and I will be back to our programming as soon as I finished rebooting.\n";
const DOCTOR_OK = "Hi Sam, I can't find any memory issue in your instance. I can only account for what occurs on this base.\n";

/** getMemoryDoctorReport() over the memory model. */
function memoryDoctor(ctx: CommandContext, r: MemoryReport): string {
  if (r.usedMemory < 5 * 1024 * 1024) return DOCTOR_EMPTY;
  const issues: string[] = [];
  if (Math.fround(r.peak / r.usedMemory) > 1.5) {
    issues.push(
      ' * Peak memory: In the past this instance used more than 150% the memory that is currently using. The allocator is normally not able to release memory after a peak, so you can expect to see a big fragmentation ratio, however this is actually harmless and is only due to the memory peak, and if the Redis instance Resident Set Size (RSS) is currently bigger than expected, the memory will be used as soon as you fill the Redis instance with more data. If the memory peak was only occasional and you want to try to reclaim memory, please try the MEMORY PURGE command, otherwise the only other option is to shutdown and restart the instance.\n\n',
    );
  }
  const clients = ctx.server.clients.size;
  if (clients && r.clientsNormal / clients > 1024 * 200) {
    issues.push(
      ' * Big client buffers: The clients output buffers in this instance are greater than 200K per client (on average). This may result from different causes, like Pub/Sub clients subscribed to channels bot not receiving data fast enough, so that data piles on the Redis instance output buffer, or clients sending commands with large replies or very large sequences of commands in the same pipeline. Please use the CLIENT LIST command in order to investigate the issue if it causes problems in your instance, or to understand better why certain clients are using a big amount of memory.\n\n',
    );
  }
  if (ctx.server.scripts.size > 1000) {
    issues.push(
      " * Many scripts: There seem to be many cached scripts in this instance (more than 1000). This may be because scripts are generated and `EVAL`ed, instead of being parameterized (with KEYS and ARGV), `SCRIPT LOAD`ed and `EVALSHA`ed. Unless `SCRIPT FLUSH` is called periodically, the scripts' caches may end up consuming most of your memory.\n\n",
    );
  }
  if (!issues.length) return DOCTOR_OK;
  return `Sam, I detected a few issues in this Redis instance memory implants:\n\n${issues.join('')}I'm here to keep you safe, Sam. I want to help you.\n`;
}

function memory(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const argc = args.length + 1;
  if (sub === 'usage' && argc >= 3) {
    let samples = 5;
    for (let j = 2; j < args.length; j++) {
      if (args[j].toLowerCase() === 'samples' && j + 1 < args.length) {
        samples = parseInteger(args[j + 1]);
        if (samples < 0) throw new CommandError(RespMessages.SYNTAX);
        j++;
      } else throw new CommandError(RespMessages.SYNTAX);
    }
    const v = ctx.db.peek(args[1]);
    // SAMPLES 0 = every element
    return v ? memoryUsage(args[1], v, encodingOf(ctx, v), memoryOpts(ctx, args[1], v, samples)) : null;
  }
  if (sub === 'doctor' && argc === 2) return new RespVerbatim(memoryDoctor(ctx, ctx.server.memoryReport()));
  if (sub === 'stats' && argc === 2) return new RespMap(memoryStats(ctx.server.memoryReport()).map(([k, v]) => [k, statValue(v)]));
  if (sub === 'malloc-stats' && argc === 2) return new Status('Stats not supported for the current allocator');
  if (sub === 'purge' && argc === 2) return OK;
  if (sub === 'help' && argc === 2) return helpReply('memory', HELP_TEXT.memory);
  throw subcommandSyntaxError(args[0], 'memory');
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

const DEBUG_HELP = [
  'CHANGE-REPL-ID',
  '    Change the replication IDs of the instance.',
  '    Dangerous: should be used only for testing the replication subsystem.',
  'LISTPACK <key>',
  '    Show low level info about the listpack encoding of <key>.',
  'LOADAOF',
  '    Flush the AOF buffers on disk and reload the AOF in memory.',
  'LOG <message>',
  '    Write <message> to the server log.',
  'OBJECT <key> [fast]',
  '    Show low level info about the <key> and associated value.',
  '    Some fields of the default behavior may be time consuming to fetch,',
  '    and `fast` can be passed to avoid fetching them.',
  'POPULATE <count> [<prefix>] [<size>]',
  '    Create <count> string keys named key:<num>. If <prefix> is specified then',
  '    it is used instead of the \'key\' prefix. These are not propagated to',
  '    replicas. Cluster slots are not respected so keys not belonging to the',
  '    current node can be created in cluster mode.',
  'QUICKLIST <key> [<0|1>]',
  '    Show low level info about the quicklist encoding of <key>.',
  '    The optional argument (0 by default) sets the level of detail',
  'QUICKLIST-PACKED-THRESHOLD <size>',
  '    Sets the threshold for elements to be inserted as plain vs packed nodes',
  '    Default value is 1GB, allows values up to 4GB. Setting to 0 restores to default.',
  'RELOAD [option ...]',
  '    Save the RDB on disk and reload it back to memory. Valid <option> values:',
  '    * MERGE: conflicting keys will be loaded from RDB.',
  '    * NOFLUSH: the existing database will not be removed before load, but',
  '      conflicting keys will generate an exception and kill the server.',
  '    * NOSAVE: the database will be loaded from an existing RDB file.',
  '    Examples:',
  '    * DEBUG RELOAD: verify that the server is able to persist, flush and reload',
  '      the database.',
  '    * DEBUG RELOAD NOSAVE: replace the current database with the contents of an',
  '      existing RDB file.',
  '    * DEBUG RELOAD NOSAVE NOFLUSH MERGE: add the contents of an existing RDB',
  '      file to the database.',
  'SET-ACTIVE-EXPIRE <0|1>',
  '    Setting it to 0 disables expiring keys in background when they are not',
  '    accessed (otherwise the Redis behavior). Setting it to 1 reenables back the',
  '    default.',
  'SLEEP <seconds>',
  '    Stop the server for <seconds>. Decimals allowed.',
  'STRINGMATCH-LEN',
  '    Run a fuzz tester against the stringmatchlen() function.',
];

/** A stable fake object address for DEBUG OBJECT `Value at:%p`. */
function fakeAddress(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return `0x7f${(h & 0xffffff).toString(16).padStart(6, '0')}${((h >>> 8) & 0xfff0).toString(16).padStart(4, '0')}`;
}

/** DEBUG OBJECT key [fast]. */
function debugObject(ctx: CommandContext, key: string, fast: boolean): Reply {
  const v = ctx.db.peek(key);
  if (!v) throw new CommandError('ERR no such key');
  const cfg = ctx.server.config;
  const enc = encodingOf(ctx, v);
  // shared integers 0..9999 (OBJ_SHARED_REFCOUNT), as OBJECT REFCOUNT reports
  const shared = v.type === 'string' && !v.raw && /^(0|[1-9]\d{0,3})$/.test(v.value) && cfg.get('maxmemory') === '0';
  const refcount = shared ? 2147483647 : 1;
  const idle = ctx.db.idleSeconds(key);
  const now = Date.now();
  // robj->lru: the LRU clock (seconds, 24 bits) of the last access, or (minutes << 8 | counter) under an LFU policy
  const lru = cfg.lfu
    ? (((Math.floor(now / 60000) & 0xffff) << 8) | ctx.db.frequency(key)) >>> 0
    : (Math.floor(now / 1000) - idle) & 0xffffff;
  let extra = '';
  if (v.type === 'list' && enc === 'quicklist') {
    const q = debugQuicklistInfo(v.value, cfg.num('list-max-listpack-size'), cfg.num('list-compress-depth'));
    extra =
      ` ql_nodes:${q.nodes} ql_avg_node:${q.avgNode.toFixed(2)} ql_listpack_max:${q.listpackMax}` +
      ` ql_compressed:${q.compressed} ql_uncompressed_size:${q.uncompressedSize}`;
  }
  const serialized = fast ? '' : ` serializedlength:${serializedLength(v, rdbOptions(ctx), v.type === 'hash' ? hashFieldExpires(v.value) : undefined)}`;
  return new Status(`Value at:${fakeAddress(key)} refcount:${refcount} encoding:${enc}${serialized} lru:${lru} lru_seconds_idle:${idle}${extra}`);
}

/** DEBUG POPULATE count [prefix] [size]: string keys `<prefix>:<n>` = `value:<n>` (padded / cut to size with NULs). */
function debugPopulate(ctx: CommandContext, args: string[]): Reply {
  const positive = (raw: string): number => {
    const n = parseInteger(raw);
    if (n < 0) throw new CommandError('ERR value is out of range, must be positive');
    return n;
  };
  const count = positive(args[1]);
  const prefix = args.length >= 3 ? args[2] : 'key';
  const size = args.length === 4 ? positive(args[3]) : 0;
  for (let j = 0; j < count; j++) {
    const key = `${prefix}:${j}`;
    if (ctx.db.peek(key) !== undefined) continue;
    let value = `value:${j}`;
    if (size) value = value.length >= size ? value.slice(0, size) : value + '\0'.repeat(size - value.length);
    ctx.db.set(key, { type: 'string', value });
    ctx.server.touch(ctx.client.dbIndex, key);
  }
  return OK;
}

/** DEBUG (debugCommand in debug.c): the subcommands that make sense without a C runtime. */
function debug(ctx: CommandContext, args: string[]): Reply {
  const sub = args[0].toLowerCase();
  const argc = args.length + 1;
  const s = ctx.server;
  switch (sub) {
    case 'help':
      if (argc === 2) return helpReply('debug', DEBUG_HELP);
      break;
    case 'object':
      if (argc === 3 || argc === 4) return debugObject(ctx, args[1], argc === 4 && args[2].toLowerCase() === 'fast');
      break;
    case 'sleep':
      if (argc === 3) {
        // Redis: strtod(), no validation
        const seconds = Number.parseFloat(args[1]);
        blockingSleep(Number.isFinite(seconds) ? seconds * 1000 : 0);
        return OK;
      }
      break;
    case 'set-active-expire':
      if (argc === 3) {
        s.activeExpire = Number.parseInt(args[1], 10) !== 0 && !Number.isNaN(Number.parseInt(args[1], 10));
        return OK;
      }
      break;
    case 'change-repl-id':
      if (argc === 2) {
        s.replId = randomBytes(20).toString('hex');
        return OK;
      }
      break;
    case 'quicklist-packed-threshold':
      if (argc === 3) {
        const m = /^(\d+)(b|k|kb|m|mb|g|gb)?$/i.exec(args[1]);
        const mul: Record<string, number> = { b: 1, k: 1e3, kb: 1024, m: 1e6, mb: 1048576, g: 1e9, gb: 1073741824 };
        const size = m ? Number(m[1]) * mul[(m[2] ?? 'b').toLowerCase()] : NaN;
        // quicklistSetPackedThreshold(): 0 restores the default, otherwise at most 4GB (the threshold itself is not modelled)
        if (!m || size > 2 ** 32) throw new CommandError('ERR argument must be a memory value bigger than 1 and smaller than 4gb');
        return OK;
      }
      break;
    case 'listpack':
    case 'quicklist':
      if (argc === 3 || (sub === 'quicklist' && argc === 4)) {
        const v = ctx.db.peek(args[1]);
        if (!v) throw new CommandError('ERR no such key');
        const enc = encodingOf(ctx, v);
        if (sub === 'listpack') {
          if (enc !== 'listpack' && enc !== 'listpackex') throw new CommandError('ERR Not a listpack encoded object.');
          return new Status('Listpack structure printed on stdout');
        }
        if (enc !== 'quicklist') throw new CommandError('ERR Not a quicklist encoded object.');
        return new Status('Quicklist structure printed on stdout');
      }
      break;
    case 'stringmatch-len':
      if (argc === 2) return new Status('Apparently Redis did not crash: test passed');
      break;
    case 'populate':
      if (argc >= 3 && argc <= 5) return debugPopulate(ctx, args);
      break;
    case 'log':
      if (argc === 3) {
        s.log('warn', `DEBUG LOG: ${args[1]}`);
        return OK;
      }
      break;
    case 'reload':
      return s.debugHooks.reload ? s.debugHooks.reload(ctx.client, args.slice(1)) : OK;
    case 'loadaof':
      if (argc === 2) {
        return s.debugHooks.loadaof ? s.debugHooks.loadaof(ctx.client) : OK;
      }
      break;
    case 'set-disable-deny-scripts':
    case 'set-skip-checksum-validation':
    case 'pause-cron':
    case 'dict-resizing':
      if (argc === 3) return OK;
      break;
  }
  throw subcommandSyntaxError(args[0], 'debug');
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
      const opts = { save: false, nosave: false, now: false, force: false, abort: false };
      for (const a of args) {
        const o = a.toLowerCase();
        if (o === 'save' || o === 'nosave' || o === 'now' || o === 'force' || o === 'abort') opts[o] = true;
        else throw new CommandError(RespMessages.SYNTAX);
      }
      if ((opts.save && opts.nosave) || (opts.abort && args.length > 1)) throw new CommandError(RespMessages.SYNTAX);
      if (opts.abort) throw new CommandError('ERR No shutdown in progress.');
      if (!ctx.server.shutdown(opts)) throw new CommandError('ERR Errors trying to SHUTDOWN. Check logs.');
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
    handler: (ctx) => ctx.server.persistence.saveCommand(),
  },
  {
    name: 'bgsave',
    arity: -1,
    flags: { noscript: true },
    handler: (ctx, args) => {
      if (args.length > 1 || (args.length === 1 && args[0].toLowerCase() !== 'schedule')) throw new CommandError(RespMessages.SYNTAX);
      return ctx.server.persistence.bgsaveCommand({ schedule: args.length === 1, inExec: ctx.client.inExec });
    },
  },
  {
    name: 'bgrewriteaof',
    arity: 1,
    flags: { noscript: true },
    handler: (ctx) => ctx.server.persistence.bgrewriteaofCommand(ctx.client.inExec),
  },
  { name: 'lastsave', arity: 1, handler: (ctx) => ctx.server.persistence.lastsaveCommand() },
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
  { name: 'debug', arity: -2, flags: { noscript: true }, handler: debug },
];
