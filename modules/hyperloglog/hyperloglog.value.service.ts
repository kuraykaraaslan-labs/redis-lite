import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Status } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
import MemoryService from '@/modules/memory/memory.service';
import type { StringValue } from '@/modules/memory/memory.types';

import type { PfAddInput, PfCountInput, PfMergeInput } from './hyperloglog.dto';
import { HLL_DENSE, HLL_REGISTERS } from './hyperloglog.encoding';
import HyperLogLogMessages from './hyperloglog.messages';
import { Hll, countRaw } from './hyperloglog.structure';

/**
 * PFADD, PFCOUNT, PFMERGE. Like Redis, the value is a string (TYPE says "string") holding the HLL representation
 * described in hyperloglog.encoding.ts; Redis leaves these strings raw-encoded.
 */
export default class HyperLogLogValueService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  private static readonly DEFAULT_SPARSE_MAX_BYTES = 3000;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static sparseMaxBytes(ctx: CommandContext): number {
    const n = Number(ctx.server.config.get('hll-sparse-max-bytes'));
    return Number.isFinite(n) ? n : HyperLogLogValueService.DEFAULT_SPARSE_MAX_BYTES;
  }

  /** The HLL at `key`, undefined when missing; WRONGTYPE for other types or invalid HLL strings. */
  private static read(ctx: CommandContext, key: string): Hll | undefined {
    const raw = ctx.db.get(key, 'string');
    if (raw === undefined) return undefined;
    const hll = Hll.fromString(raw);
    if (!hll) throw new AppError(HyperLogLogMessages.WRONGTYPE);
    hll.sds = MemoryService.stringSds(ctx.db.raw(key) as StringValue);
    return hll;
  }

  private static write(ctx: CommandContext, key: string, hll: Hll): void {
    ctx.db.set(key, { type: 'string', value: hll.toString(), raw: true, sds: hll.sds }, true);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** PFADD: 1 when the HLL was created or a register changed, else 0. */
  static add(ctx: CommandContext, { key, elements }: PfAddInput): number {
    const max = HyperLogLogValueService.sparseMaxBytes(ctx);
    let hll = HyperLogLogValueService.read(ctx, key);
    let updated = 0;
    if (!hll) {
      hll = Hll.create();
      updated++;
    }
    for (const element of elements) {
      const result = hll.add(Buffer.from(element, 'latin1'), max);
      if (result === 1) updated++;
      else if (result === -1) {
        // Registers set before the corruption was found stay modified, like Redis's in-place update.
        HyperLogLogValueService.write(ctx, key, hll);
        ctx.noop = true;
        throw new AppError(HyperLogLogMessages.INVALID);
      }
    }
    if (updated) hll.invalidateCache();
    else ctx.noop = true;
    HyperLogLogValueService.write(ctx, key, hll);
    return updated ? 1 : 0;
  }

  /** PFCOUNT: one key uses (and refreshes) the cached cardinality; several keys count their union. */
  static count(ctx: CommandContext, { keys }: PfCountInput): number {
    if (keys.length > 1) {
      const max = new Uint8Array(HLL_REGISTERS);
      for (const key of keys) {
        const hll = HyperLogLogValueService.read(ctx, key);
        if (!hll) continue;
        if (!hll.mergeInto(max)) throw new AppError(HyperLogLogMessages.INVALID);
      }
      return countRaw(max);
    }
    const [key] = keys;
    const hll = HyperLogLogValueService.read(ctx, key);
    if (!hll) return 0;
    if (hll.cacheValid) {
      HyperLogLogValueService.write(ctx, key, hll);
      return hll.cachedCardinality;
    }
    const card = hll.count();
    if (card === undefined) throw new AppError(HyperLogLogMessages.INVALID);
    hll.cachedCardinality = card;
    HyperLogLogValueService.write(ctx, key, hll);
    // A read-only command, but the cached cardinality changed the stored string: Redis signals the key.
    ctx.server.touch(ctx.client.dbIndex, key);
    return card;
  }

  /** PFMERGE: the union of every key (destination included) into the destination; dense if any input is. */
  static merge(ctx: CommandContext, { destination, keys }: PfMergeInput): Status {
    const max = new Uint8Array(HLL_REGISTERS);
    let useDense = false;
    for (const key of keys) {
      const hll = HyperLogLogValueService.read(ctx, key);
      if (!hll) continue;
      if (hll.encoding === HLL_DENSE) useDense = true;
      if (!hll.mergeInto(max)) throw new AppError(HyperLogLogMessages.INVALID);
    }
    const hll = HyperLogLogValueService.read(ctx, destination) ?? Hll.create();
    if (useDense && !hll.toDense()) throw new AppError(HyperLogLogMessages.INVALID);
    const sparseMax = HyperLogLogValueService.sparseMaxBytes(ctx);
    for (let j = 0; j < HLL_REGISTERS; j++) {
      if (max[j] === 0) continue;
      hll.set(j, max[j], sparseMax);
    }
    hll.invalidateCache();
    HyperLogLogValueService.write(ctx, destination, hll);
    return OK;
  }
}
