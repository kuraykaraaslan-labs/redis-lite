import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import { OK, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { PfDebugInput, PfSelfTestInput } from './hyperloglog.dto';
import { HLL_DENSE, HLL_HDR_SIZE, HLL_REGISTERS, HLL_SPARSE, denseGet, denseSetReg, sparseRuns } from './hyperloglog.encoding';
import HyperLogLogMessages from './hyperloglog.messages';
import { Hll } from './hyperloglog.structure';

/** Introspection and self checks: PFDEBUG, PFSELFTEST. */
export default class HyperLogLogDebugService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────
  private static readonly DEFAULT_SPARSE_MAX_BYTES = 3000;

  /** Same scale as Redis (HLL_TEST_CYCLES and 10M elements): blocks the server for several seconds. */
  private static readonly SELFTEST_REGISTER_CYCLES = 1000;
  private static readonly SELFTEST_ELEMENTS = 10_000_000;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static sparseMaxBytes(ctx: CommandContext): number {
    const n = Number(ctx.server.config.get('hll-sparse-max-bytes'));
    return Number.isFinite(n) ? n : HyperLogLogDebugService.DEFAULT_SPARSE_MAX_BYTES;
  }

  private static write(ctx: CommandContext, key: string, hll: Hll): void {
    ctx.db.set(key, { type: 'string', value: hll.toString(), raw: true }, true);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** PFDEBUG's read step, before its arguments are checked: WRONGTYPE, then a missing key. */
  static debugRead(ctx: CommandContext, { key }: { key: string }): Hll {
    // Redis does not signal the key for PFDEBUG, even when it changes the encoding.
    ctx.noop = true;
    const raw = ctx.db.get(key, 'string');
    const hll = raw === undefined ? undefined : Hll.fromString(raw);
    if (raw !== undefined && !hll) throw new AppError(HyperLogLogMessages.WRONGTYPE);
    if (!hll) throw new AppError(HyperLogLogMessages.KEY_NOT_FOUND);
    return hll;
  }

  /** PFDEBUG GETREG | DECODE | ENCODING | TODENSE on the HLL read first; the value is written back in every case. */
  static debug(ctx: CommandContext, hll: Hll, { name, key, subcommand }: PfDebugInput): Reply {
    if (subcommand === 'getreg') {
      if (hll.encoding === HLL_SPARSE && !hll.toDense()) throw new AppError(HyperLogLogMessages.INVALID);
      HyperLogLogDebugService.write(ctx, key, hll);
      const out: number[] = [];
      for (let j = 0; j < HLL_REGISTERS; j++) out.push(denseGet(hll.bytes, HLL_HDR_SIZE, j));
      return out;
    }
    if (subcommand === 'decode') {
      HyperLogLogDebugService.write(ctx, key, hll);
      if (hll.encoding !== HLL_SPARSE) throw new AppError(HyperLogLogMessages.NOT_SPARSE);
      return sparseRuns(hll.bytes)
        .map((r) => (r.kind === 'zero' ? `z:${r.len}` : r.kind === 'xzero' ? `Z:${r.len}` : `v:${r.value},${r.len}`))
        .join(' ');
    }
    if (subcommand === 'encoding') {
      HyperLogLogDebugService.write(ctx, key, hll);
      return new Status(hll.encoding === HLL_DENSE ? 'dense' : 'sparse');
    }
    if (subcommand === 'todense') {
      let converted = 0;
      if (hll.encoding === HLL_SPARSE) {
        if (!hll.toDense()) throw new AppError(HyperLogLogMessages.INVALID);
        converted = 1;
      }
      HyperLogLogDebugService.write(ctx, key, hll);
      return converted;
    }
    HyperLogLogDebugService.write(ctx, key, hll);
    throw new AppError(formatMessage(HyperLogLogMessages.DEBUG_UNKNOWN, { subcommand: name }));
  }

  /** PFSELFTEST: register access, then dense vs sparse approximation error, as Redis tests them. */
  static selfTest(ctx: CommandContext, _input: PfSelfTestInput): Status {
    const sparseMax = HyperLogLogDebugService.sparseMaxBytes(ctx);
    const dense = new Uint8Array(HLL_HDR_SIZE + Math.floor((HLL_REGISTERS * 6 + 7) / 8));
    const bytecounters = new Uint8Array(HLL_REGISTERS);

    // Test 1: register access.
    for (let j = 0; j < HyperLogLogDebugService.SELFTEST_REGISTER_CYCLES; j++) {
      for (let i = 0; i < HLL_REGISTERS; i++) {
        const r = Math.floor(Math.random() * 64);
        bytecounters[i] = r;
        denseSetReg(dense, HLL_HDR_SIZE, i, r);
      }
      for (let i = 0; i < HLL_REGISTERS; i++) {
        const val = denseGet(dense, HLL_HDR_SIZE, i);
        if (val !== bytecounters[i]) {
          throw new AppError(formatMessage(HyperLogLogMessages.SELFTEST_REGISTER, { index: i, expected: bytecounters[i], actual: val }));
        }
      }
    }

    // Test 2: approximation error, dense and sparse side by side.
    dense.fill(0);
    dense.set([0x48, 0x59, 0x4c, 0x4c]);
    dense[4] = HLL_DENSE;
    const denseHll = new Hll(dense);
    const sparse = Hll.create();
    const relerr = 1.04 / Math.sqrt(HLL_REGISTERS);
    let checkpoint = 1;
    const seed = BigInt(Math.floor(Math.random() * 2 ** 31)) | (BigInt(Math.floor(Math.random() * 2 ** 31)) << 32n);
    const ele = Buffer.alloc(8);
    for (let j = 1; j <= HyperLogLogDebugService.SELFTEST_ELEMENTS; j++) {
      ele.writeBigUInt64LE(BigInt(j) ^ seed);
      denseHll.add(ele, sparseMax);
      sparse.add(ele, sparseMax);
      if (j !== checkpoint) continue;
      if (j < sparseMax / 2 && sparse.encoding !== HLL_SPARSE) throw new AppError(HyperLogLogMessages.SELFTEST_SPARSE_NOT_USED);
      const card = denseHll.count() ?? 0;
      if (card !== sparse.count()) throw new AppError(HyperLogLogMessages.SELFTEST_DISAGREE);
      let maxerr = Math.ceil(relerr * 6 * checkpoint);
      if (j === 10) maxerr = 1;
      const abserr = Math.abs(checkpoint - card);
      if (abserr > maxerr) throw new AppError(formatMessage(HyperLogLogMessages.SELFTEST_TOO_BIG, { card: checkpoint, abserr }));
      checkpoint *= 10;
    }
    return OK;
  }
}
