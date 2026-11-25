import { OK, RespDouble, RespMap, RespVerbatim, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';
import DatabaseService from '@/modules/database/database.service';
import HashesService from '@/modules/hashes/hashes.service';
import MemoryService from '@/modules/memory/memory.service';
import type { MemoryReport, MemoryStatValue } from '@/modules/memory/memory.types';
import type { RedisValue } from '@/modules/database/database.types';

import type { MemoryUsageInput } from './server.dto';
import ServerMessages from './server.messages';

/** MEMORY: USAGE of a key, STATS and DOCTOR over the memory model, and the allocator subcommands. */
export default class ServerMemoryService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The OBJECT ENCODING of a value under the live config. */
  private static encodingOf(ctx: CommandContext, v: RedisValue): string {
    return DatabaseService.objectEncoding(v, ctx.server.config, v.type === 'hash' && HashesService.hashFieldExpires(v.value) !== undefined);
  }

  /** Options of the memory model that follow the live config. */
  private static usageOptions(ctx: CommandContext, key: string, v: RedisValue, samples: number) {
    const cfg = ctx.server.config;
    return {
      samples,
      hasExpire: ctx.db.getExpire(key) !== undefined,
      fieldTtls: v.type === 'hash' ? HashesService.hashFieldExpires(v.value) : undefined,
      listMaxListpackSize: cfg.num('list-max-listpack-size'),
      streamNodeMaxEntries: cfg.num('stream-node-max-entries'),
      streamNodeMaxBytes: cfg.num('stream-node-max-bytes'),
    };
  }

  private static statValue(v: MemoryStatValue): Reply {
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return new RespMap(v.map(([k, n]) => [k, n]));
    return new RespDouble(v.double);
  }

  /** getMemoryDoctorReport() over the memory model. */
  private static doctorReport(ctx: CommandContext, r: MemoryReport): string {
    if (r.usedMemory < 5 * 1024 * 1024) return ServerMessages.MEMORY_DOCTOR_EMPTY;
    const issues: string[] = [];
    if (Math.fround(r.peak / r.usedMemory) > 1.5) issues.push(ServerMessages.MEMORY_DOCTOR_PEAK);
    const clients = ctx.server.clients.size;
    if (clients && r.clientsNormal / clients > 1024 * 200) issues.push(ServerMessages.MEMORY_DOCTOR_BIG_CLIENTS);
    if (ctx.server.scripts.size > 1000) issues.push(ServerMessages.MEMORY_DOCTOR_SCRIPTS);
    if (!issues.length) return ServerMessages.MEMORY_DOCTOR_OK;
    return `${ServerMessages.MEMORY_DOCTOR_HEADER}${issues.join('')}${ServerMessages.MEMORY_DOCTOR_FOOTER}`;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** MEMORY USAGE key [SAMPLES count]: null for a missing key. */
  static usage(ctx: CommandContext, { key, samples }: MemoryUsageInput): Reply {
    const v = ctx.db.peek(key);
    return v ? MemoryService.memoryUsage(key, v, ServerMemoryService.encodingOf(ctx, v), ServerMemoryService.usageOptions(ctx, key, v, samples)) : null;
  }

  static doctor(ctx: CommandContext): Reply {
    return new RespVerbatim(ServerMemoryService.doctorReport(ctx, ctx.server.memoryReport()));
  }

  static stats(ctx: CommandContext): Reply {
    return new RespMap(MemoryService.memoryStats(ctx.server.memoryReport()).map(([k, v]) => [k, ServerMemoryService.statValue(v)]));
  }

  static mallocStats(): Reply {
    return new Status(ServerMessages.MALLOC_STATS);
  }

  static purge(): Reply {
    return OK;
  }

  static help(): Reply {
    return CommandService.helpReply('memory');
  }
}
