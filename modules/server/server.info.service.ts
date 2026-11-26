import { arch, release, totalmem, type as osType } from 'node:os';

import { RespVerbatim } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import MemoryService from '@/modules/memory/memory.service';
import TrackingService from '@/modules/tracking/tracking.service';

import { REDIS_VERSION } from './server.constants';
import type { InfoInput } from './server.dto';

/** INFO: the server's report, section by section, in Redis's order and format. */
export default class ServerInfoService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Sections in Redis order; `def` = part of the default set. */
  private static readonly SECTIONS: Array<[name: string, title: string, def: boolean]> = [
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

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The `key:value` lines of one section. */
  private static section(ctx: CommandContext, name: string): string[] {
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
          // replicas are not counted (they are listed in the replication section)
          `connected_clients:${clients.filter((c) => !c.replica?.attached).length}`,
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
        return MemoryService.infoMemory(report, {
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
        const tracking = TrackingService.stats(s.tracking);
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
          `sync_full:${s.replication.stats.syncFull}`,
          `sync_partial_ok:${s.replication.stats.syncPartialOk}`,
          `sync_partial_err:${s.replication.stats.syncPartialErr}`,
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
        return s.replication.infoLines(now);
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

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** INFO [section …]: the default sections, `all` / `everything`, or the named ones. */
  static info(ctx: CommandContext, { sections }: InfoInput): Reply {
    const everything = sections.has('all') || sections.has('everything');
    const def = !sections.size || sections.has('default');
    const out: string[] = [];
    for (const [name, title, isDefault] of ServerInfoService.SECTIONS) {
      if (!(everything || sections.has(name) || (def && isDefault))) continue;
      out.push(`# ${title}\r\n${ServerInfoService.section(ctx, name).map((l) => `${l}\r\n`).join('')}`);
    }
    return new RespVerbatim(out.join('\r\n'));
  }
}
