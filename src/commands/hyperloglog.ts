import { CommandError } from '../errors';
import type { Reply } from '../resp';
import { OK, Status } from '../resp';
import {
  HLL_DENSE,
  HLL_HDR_SIZE,
  HLL_INVALID,
  HLL_REGISTERS,
  HLL_SPARSE,
  HLL_WRONGTYPE,
  Hll,
  countRaw,
  denseGet,
  denseSetReg,
  sparseRuns,
} from '../store/hll';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

/**
 * HyperLogLog commands. Like Redis, the value is a string (TYPE says "string") holding the HLL
 * representation described in store/hll.ts; Redis leaves these strings raw-encoded.
 */

const DEFAULT_SPARSE_MAX_BYTES = 3000;

function sparseMaxBytes(ctx: CommandContext): number {
  const n = Number(ctx.server.config.get('hll-sparse-max-bytes'));
  return Number.isFinite(n) ? n : DEFAULT_SPARSE_MAX_BYTES;
}

/** The HLL at `key`, undefined when missing; WRONGTYPE for other types or invalid HLL strings. */
function read(ctx: CommandContext, key: string): Hll | undefined {
  const raw = ctx.db.get(key, 'string');
  if (raw === undefined) return undefined;
  const hll = Hll.fromString(raw);
  if (!hll) throw new CommandError(HLL_WRONGTYPE);
  return hll;
}

function write(ctx: CommandContext, key: string, hll: Hll): void {
  ctx.db.set(key, { type: 'string', value: hll.toString(), raw: true }, true);
}

function latin1Bytes(s: string): Uint8Array {
  return Buffer.from(s, 'latin1');
}

function pfadd(ctx: CommandContext, args: string[]): Reply {
  const [key] = args;
  const max = sparseMaxBytes(ctx);
  let hll = read(ctx, key);
  let updated = 0;
  if (!hll) {
    hll = Hll.create();
    updated++;
  }
  for (let j = 1; j < args.length; j++) {
    const r = hll.add(latin1Bytes(args[j]), max);
    if (r === 1) updated++;
    else if (r === -1) {
      // Registers set before the corruption was found stay modified, like Redis's in-place update.
      write(ctx, key, hll);
      ctx.noop = true;
      throw new CommandError(HLL_INVALID);
    }
  }
  if (updated) hll.invalidateCache();
  else ctx.noop = true;
  write(ctx, key, hll);
  return updated ? 1 : 0;
}

function pfcount(ctx: CommandContext, args: string[]): Reply {
  if (args.length > 1) {
    const max = new Uint8Array(HLL_REGISTERS);
    for (const key of args) {
      const hll = read(ctx, key);
      if (!hll) continue;
      if (!hll.mergeInto(max)) throw new CommandError(HLL_INVALID);
    }
    return countRaw(max);
  }
  const [key] = args;
  const hll = read(ctx, key);
  if (!hll) return 0;
  if (hll.cacheValid) {
    write(ctx, key, hll);
    return hll.cachedCardinality;
  }
  const card = hll.count();
  if (card === undefined) throw new CommandError(HLL_INVALID);
  hll.cachedCardinality = card;
  write(ctx, key, hll);
  // A read-only command, but the cached cardinality changed the stored string: Redis signals the key.
  ctx.server.touch(ctx.client.dbIndex, key);
  return card;
}

function pfmerge(ctx: CommandContext, args: string[]): Reply {
  const max = new Uint8Array(HLL_REGISTERS);
  let useDense = false;
  // The destination is merged too (it is the first key).
  for (const key of args) {
    const hll = read(ctx, key);
    if (!hll) continue;
    if (hll.encoding === HLL_DENSE) useDense = true;
    if (!hll.mergeInto(max)) throw new CommandError(HLL_INVALID);
  }
  const [dest] = args;
  const hll = read(ctx, dest) ?? Hll.create();
  if (useDense && !hll.toDense()) throw new CommandError(HLL_INVALID);
  const sparseMax = sparseMaxBytes(ctx);
  for (let j = 0; j < HLL_REGISTERS; j++) {
    if (max[j] === 0) continue;
    hll.set(j, max[j], sparseMax);
  }
  hll.invalidateCache();
  write(ctx, dest, hll);
  return OK;
}

function pfdebug(ctx: CommandContext, args: string[]): Reply {
  const [cmd, key] = args;
  // Redis does not signal the key for PFDEBUG, even when it changes the encoding.
  ctx.noop = true;
  const hll = read(ctx, key);
  if (!hll) throw new CommandError('ERR The specified key does not exist');
  const arityError = (): CommandError => new CommandError(`ERR Wrong number of arguments for the '${cmd}' subcommand`);
  const sub = cmd.toLowerCase();
  if (sub === 'getreg') {
    if (args.length !== 2) throw arityError();
    if (hll.encoding === HLL_SPARSE && !hll.toDense()) throw new CommandError(HLL_INVALID);
    write(ctx, key, hll);
    const out: number[] = [];
    for (let j = 0; j < HLL_REGISTERS; j++) out.push(denseGet(hll.bytes, HLL_HDR_SIZE, j));
    return out;
  }
  if (sub === 'decode') {
    if (args.length !== 2) throw arityError();
    write(ctx, key, hll);
    if (hll.encoding !== HLL_SPARSE) throw new CommandError('ERR HLL encoding is not sparse');
    return sparseRuns(hll.bytes)
      .map((r) => (r.kind === 'zero' ? `z:${r.len}` : r.kind === 'xzero' ? `Z:${r.len}` : `v:${r.value},${r.len}`))
      .join(' ');
  }
  if (sub === 'encoding') {
    if (args.length !== 2) throw arityError();
    write(ctx, key, hll);
    return new Status(hll.encoding === HLL_DENSE ? 'dense' : 'sparse');
  }
  if (sub === 'todense') {
    if (args.length !== 2) throw arityError();
    let conv = 0;
    if (hll.encoding === HLL_SPARSE) {
      if (!hll.toDense()) throw new CommandError(HLL_INVALID);
      conv = 1;
    }
    write(ctx, key, hll);
    return conv;
  }
  write(ctx, key, hll);
  throw new CommandError(`ERR Unknown PFDEBUG subcommand '${cmd}'`);
}

/** Same scale as Redis (HLL_TEST_CYCLES and 10M elements): blocks the server for several seconds. */
const SELFTEST_REGISTER_CYCLES = 1000;
const SELFTEST_ELEMENTS = 10_000_000;

function pfselftest(ctx: CommandContext): Reply {
  const sparseMax = sparseMaxBytes(ctx);
  const dense = new Uint8Array(HLL_HDR_SIZE + Math.floor((HLL_REGISTERS * 6 + 7) / 8));
  const bytecounters = new Uint8Array(HLL_REGISTERS);

  // Test 1: register access.
  for (let j = 0; j < SELFTEST_REGISTER_CYCLES; j++) {
    for (let i = 0; i < HLL_REGISTERS; i++) {
      const r = Math.floor(Math.random() * 64);
      bytecounters[i] = r;
      denseSetReg(dense, HLL_HDR_SIZE, i, r);
    }
    for (let i = 0; i < HLL_REGISTERS; i++) {
      const val = denseGet(dense, HLL_HDR_SIZE, i);
      if (val !== bytecounters[i]) {
        throw new CommandError(`ERR TESTFAILED Register ${i} should be ${bytecounters[i]} but is ${val}`);
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
  for (let j = 1; j <= SELFTEST_ELEMENTS; j++) {
    ele.writeBigUInt64LE(BigInt(j) ^ seed);
    denseHll.add(ele, sparseMax);
    sparse.add(ele, sparseMax);
    if (j !== checkpoint) continue;
    if (j < sparseMax / 2 && sparse.encoding !== HLL_SPARSE) throw new CommandError('ERR TESTFAILED sparse encoding not used');
    const card = denseHll.count() ?? 0;
    if (card !== sparse.count()) throw new CommandError('ERR TESTFAILED dense/sparse disagree');
    let maxerr = Math.ceil(relerr * 6 * checkpoint);
    if (j === 10) maxerr = 1;
    const abserr = Math.abs(checkpoint - card);
    if (abserr > maxerr) throw new CommandError(`ERR TESTFAILED Too big error. card:${checkpoint} abserr:${abserr}`);
    checkpoint *= 10;
  }
  return OK;
}

export const hyperloglogCommands: CommandSpec[] = [
  { name: 'pfadd', arity: -2, flags: { write: true }, keys: keysAt(0), handler: pfadd },
  { name: 'pfcount', arity: -2, keys: keysAt(0, -1), handler: pfcount },
  { name: 'pfmerge', arity: -2, flags: { write: true }, keys: keysAt(0), handler: pfmerge },
  { name: 'pfdebug', arity: -3, flags: { write: true }, keys: keysAt(1), handler: pfdebug },
  { name: 'pfselftest', arity: 1, handler: (ctx) => pfselftest(ctx) },
];
