import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import type { Reply } from '../resp';
import { RespMap } from '../resp';
import { intReply, parseInt64, parseInteger } from '../util';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

/** Bitmaps operate on string values: each char of a binary string is one byte. */
const W = { write: true } as const;

function bytesOf(ctx: CommandContext, key: string): number[] {
  const v = ctx.db.get(key, 'string') ?? '';
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i);
  return out;
}

function store(ctx: CommandContext, key: string, bytes: number[]): void {
  ctx.db.set(key, { type: 'string', value: chunked(bytes), raw: true }, true);
}

function chunked(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 65536) out += String.fromCharCode(...bytes.slice(i, i + 65536));
  return out;
}

/** Bit offsets are limited so the string stays under proto-max-bulk-len, as in Redis. */
function parseBitOffset(ctx: CommandContext, raw: string): number {
  const n = parseInteger(raw, RespMessages.BIT_OFFSET);
  if (n < 0 || Math.floor(n / 8) >= ctx.server.config.num('proto-max-bulk-len')) throw new CommandError(RespMessages.BIT_OFFSET);
  return n;
}

function getBit(bytes: number[], offset: number): number {
  const byte = bytes[offset >> 3] ?? 0;
  return (byte >> (7 - (offset & 7))) & 1;
}

function setBitIn(bytes: number[], offset: number, bit: number): void {
  const i = Math.floor(offset / 8);
  while (bytes.length <= i) bytes.push(0);
  const mask = 1 << (7 - (offset % 8));
  bytes[i] = bit ? bytes[i] | mask : bytes[i] & ~mask;
}

function popcount(b: number): number {
  let n = 0;
  for (let x = b; x; x &= x - 1) n++;
  return n;
}

/** Resolves a [start, end] range given in bytes or bits; returns bit bounds (inclusive) or null when empty. */
function bitRange(totalBytes: number, args: string[], from: number): [number, number] | null {
  if (args.length <= from) return totalBytes ? [0, totalBytes * 8 - 1] : null;
  if (args.length === from + 1) throw new CommandError(RespMessages.SYNTAX);
  let start = parseInteger(args[from]);
  let end = parseInteger(args[from + 1]);
  const unit = (args[from + 2] ?? 'byte').toLowerCase();
  if (unit !== 'byte' && unit !== 'bit') throw new CommandError(RespMessages.SYNTAX);
  const total = unit === 'bit' ? totalBytes * 8 : totalBytes;
  if (start < 0) start = Math.max(0, total + start);
  if (end < 0) end = Math.max(-1, total + end);
  if (end >= total) end = total - 1;
  if (start > end || total === 0) return null;
  return unit === 'bit' ? [start, end] : [start * 8, end * 8 + 7];
}

// ---- BITFIELD -------------------------------------------------------------------------------------------------

interface FieldType {
  signed: boolean;
  bits: number;
}

function parseFieldType(raw: string): FieldType {
  const m = /^([iu])(\d+)$/i.exec(raw);
  const err = 'ERR Invalid bitfield type. Use something like i16 u8. Note that u64 is not supported but i64 is.';
  if (!m) throw new CommandError(err);
  const signed = m[1].toLowerCase() === 'i';
  const bits = Number(m[2]);
  if (bits < 1 || (signed && bits > 64) || (!signed && bits > 63)) throw new CommandError(err);
  return { signed, bits };
}

function parseFieldOffset(ctx: CommandContext, raw: string, type: FieldType): number {
  const multiply = raw.startsWith('#');
  const n = parseInteger(multiply ? raw.slice(1) : raw, RespMessages.BIT_OFFSET);
  const offset = multiply ? n * type.bits : n;
  if (offset < 0 || Math.floor(offset / 8) >= ctx.server.config.num('proto-max-bulk-len')) throw new CommandError(RespMessages.BIT_OFFSET);
  return offset;
}

function readField(bytes: number[], offset: number, t: FieldType): bigint {
  let v = 0n;
  for (let i = 0; i < t.bits; i++) v = (v << 1n) | BigInt(getBit(bytes, offset + i));
  if (t.signed && v >> BigInt(t.bits - 1)) v -= 1n << BigInt(t.bits);
  return v;
}

function writeField(bytes: number[], offset: number, t: FieldType, value: bigint): void {
  let v = BigInt.asUintN(t.bits, value);
  for (let i = t.bits - 1; i >= 0; i--) {
    setBitIn(bytes, offset + i, Number(v & 1n));
    v >>= 1n;
  }
}

/** Applies overflow policy; returns null when FAIL rejects the value. */
function overflow(value: bigint, t: FieldType, policy: string): bigint | null {
  const min = t.signed ? -(1n << BigInt(t.bits - 1)) : 0n;
  const max = t.signed ? (1n << BigInt(t.bits - 1)) - 1n : (1n << BigInt(t.bits)) - 1n;
  if (value >= min && value <= max) return value;
  if (policy === 'fail') return null;
  if (policy === 'sat') return value < min ? min : max;
  return t.signed ? BigInt.asIntN(t.bits, value) : BigInt.asUintN(t.bits, value);
}

function bitfield(ctx: CommandContext, args: string[], readOnly: boolean): Reply {
  const key = args[0];
  const bytes = bytesOf(ctx, key);
  const out: Reply[] = [];
  let policy = 'wrap';
  let dirty = false;
  for (let i = 1; i < args.length; i++) {
    const op = args[i].toLowerCase();
    if (op === 'overflow') {
      policy = (args[++i] ?? '').toLowerCase();
      if (!['wrap', 'sat', 'fail'].includes(policy)) throw new CommandError('ERR Invalid OVERFLOW type specified');
      continue;
    }
    if (op !== 'get' && op !== 'set' && op !== 'incrby') throw new CommandError(RespMessages.SYNTAX);
    if (readOnly && op !== 'get') throw new CommandError('ERR BITFIELD_RO only supports the GET subcommand');
    // GET takes type + offset, SET/INCRBY also a value: missing arguments are a syntax error.
    if (i + (op === 'get' ? 2 : 3) >= args.length) throw new CommandError(RespMessages.SYNTAX);
    const type = parseFieldType(args[++i]);
    const offset = parseFieldOffset(ctx, args[++i], type);
    if (op === 'get') {
      out.push(intReply(readField(bytes, offset, type)));
      continue;
    }
    const raw = args[++i];
    if (raw === undefined) throw new CommandError(RespMessages.SYNTAX);
    const arg = parseInt64(raw);
    const old = readField(bytes, offset, type);
    const next = overflow(op === 'set' ? arg : old + arg, type, policy);
    if (next === null) {
      out.push(null);
      continue;
    }
    writeField(bytes, offset, type, next);
    dirty = true;
    out.push(intReply(op === 'set' ? old : next));
  }
  if (dirty) store(ctx, key, bytes);
  return out;
}

// ---- LCS ------------------------------------------------------------------------------------------------------

function lcs(ctx: CommandContext, args: string[]): Reply {
  const lcsString = (key: string): string => {
    const v = ctx.db.lookup(key);
    if (v && v.type !== 'string') throw new CommandError('ERR The specified keys must contain string values');
    return v?.type === 'string' ? v.value : '';
  };
  const a = lcsString(args[0]);
  const b = lcsString(args[1]);
  let wantLen = false;
  let wantIdx = false;
  let minLen = 0;
  let withLen = false;
  for (let i = 2; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    if (opt === 'len') wantLen = true;
    else if (opt === 'idx') wantIdx = true;
    else if (opt === 'withmatchlen') withLen = true;
    else if (opt === 'minmatchlen') minLen = Math.max(0, parseInteger(args[++i] ?? ''));
    else throw new CommandError(RespMessages.SYNTAX);
  }
  if (wantLen && wantIdx) throw new CommandError('ERR If you want both the length and indexes, please just use IDX.');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const total = dp[a.length][b.length];
  if (wantLen) return total;
  // Backtrack from the end, collecting the common string and (for IDX) contiguous match ranges, as Redis does.
  let i = a.length;
  let j = b.length;
  const chars: string[] = [];
  const matches: Reply[] = [];
  let range: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null;
  const flush = () => {
    if (!range) return;
    const len = range.aEnd - range.aStart + 1;
    if (len >= minLen) {
      const m: Reply[] = [[range.aStart, range.aEnd], [range.bStart, range.bEnd]];
      if (withLen) m.push(len);
      matches.push(m);
    }
    range = null;
  };
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      chars.push(a[i - 1]);
      const ai = i - 1;
      const bj = j - 1;
      if (range && range.aStart === ai + 1 && range.bStart === bj + 1) {
        range.aStart = ai;
        range.bStart = bj;
      } else {
        flush();
        range = { aStart: ai, aEnd: ai, bStart: bj, bEnd: bj };
      }
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  flush();
  if (wantIdx) return RespMap.from(['matches', matches, 'len', total]);
  return chars.reverse().join('');
}

export const bitmapCommands: CommandSpec[] = [
  {
    name: 'getbit',
    arity: 3,
    handler: (ctx, args) => getBit(bytesOf(ctx, args[0]), parseBitOffset(ctx, args[1])),
  },
  {
    name: 'setbit',
    arity: 4,
    flags: W,
    keys: keysAt(0),
    handler: (ctx, args) => {
      const offset = parseBitOffset(ctx, args[1]);
      if (args[2] !== '0' && args[2] !== '1') throw new CommandError('ERR bit is not an integer or out of range');
      const bytes = bytesOf(ctx, args[0]);
      const old = getBit(bytes, offset);
      setBitIn(bytes, offset, Number(args[2]));
      store(ctx, args[0], bytes);
      return old;
    },
  },
  {
    name: 'bitcount',
    arity: -2,
    handler: (ctx, args) => {
      const bytes = bytesOf(ctx, args[0]);
      const r = bitRange(bytes.length, args, 1);
      if (!r) return 0;
      let n = 0;
      for (let bit = r[0]; bit <= r[1]; ) {
        if ((bit & 7) === 0 && bit + 7 <= r[1]) {
          n += popcount(bytes[bit >> 3]);
          bit += 8;
        } else {
          n += getBit(bytes, bit);
          bit++;
        }
      }
      return n;
    },
  },
  {
    name: 'bitpos',
    arity: -3,
    handler: (ctx, args) => {
      if (args[1] !== '0' && args[1] !== '1') throw new CommandError('ERR The bit argument must be 1 or 0.');
      const want = Number(args[1]);
      const bytes = bytesOf(ctx, args[0]);
      if (!bytes.length) return want ? -1 : 0;
      const explicitEnd = args.length > 3;
      const r = args.length === 3 ? bitRangeFrom(bytes.length, args) : bitRange(bytes.length, args, 2);
      if (!r) return -1;
      for (let bit = r[0]; bit <= r[1]; bit++) if (getBit(bytes, bit) === want) return bit;
      // Looking for a clear bit with no explicit end: the string is treated as padded with zeros on the right.
      return want === 0 && !explicitEnd ? r[1] + 1 : -1;
    },
  },
  {
    name: 'bitop',
    arity: -4,
    flags: W,
    keys: keysAt(1),
    handler: (ctx, args) => {
      const op = args[0].toLowerCase();
      const dest = args[1];
      if (!['and', 'or', 'xor', 'not', 'diff', 'diff1', 'andor', 'one'].includes(op)) throw new CommandError(RespMessages.SYNTAX);
      const sources = args.slice(2).map((k) => bytesOf(ctx, k));
      if (op === 'not' && sources.length !== 1) throw new CommandError('ERR BITOP NOT must be called with a single source key.');
      if ((op === 'diff' || op === 'diff1' || op === 'andor') && sources.length < 2) {
        throw new CommandError(`ERR BITOP ${op.toUpperCase()} must be called with at least two source keys.`);
      }
      const len = Math.max(0, ...sources.map((s) => s.length));
      const out: number[] = [];
      for (let i = 0; i < len; i++) {
        const x = sources[0][i] ?? 0;
        const rest = sources.slice(1).map((s) => s[i] ?? 0);
        const anyRest = rest.reduce((acc, b) => acc | b, 0);
        let v: number;
        switch (op) {
          case 'not':
            v = ~x & 0xff;
            break;
          case 'and':
            v = rest.reduce((acc, b) => acc & b, x);
            break;
          case 'or':
            v = x | anyRest;
            break;
          case 'xor':
            v = rest.reduce((acc, b) => acc ^ b, x);
            break;
          case 'diff': // bits of the first key set in none of the others
            v = x & ~anyRest & 0xff;
            break;
          case 'diff1': // bits set in one of the others but not in the first key
            v = ~x & anyRest & 0xff;
            break;
          case 'andor': // bits of the first key set in at least one of the others
            v = x & anyRest;
            break;
          default: {
            // ONE: bits set in exactly one source key
            let ones = 0;
            let twos = 0;
            for (const b of [x, ...rest]) {
              twos |= ones & b;
              ones ^= b;
            }
            v = ones & ~twos & 0xff;
          }
        }
        out.push(v);
      }
      if (out.length) store(ctx, dest, out);
      else ctx.db.remove(dest);
      return out.length;
    },
  },
  { name: 'bitfield', arity: -2, flags: W, keys: keysAt(0), handler: (ctx, args) => bitfield(ctx, args, false) },
  { name: 'bitfield_ro', arity: -2, handler: (ctx, args) => bitfield(ctx, args, true) },
  { name: 'lcs', arity: -3, handler: lcs },
  {
    name: 'substr',
    arity: 4,
    handler: (ctx, args) => {
      const v = ctx.db.get(args[0], 'string') ?? '';
      let start = parseInteger(args[1]);
      let end = parseInteger(args[2]);
      if (start < 0) start = Math.max(0, v.length + start);
      if (end < 0) end = Math.max(0, v.length + end);
      if (end >= v.length) end = v.length - 1;
      return start > end || !v.length ? '' : v.slice(start, end + 1);
    },
  },
];

/** BITPOS key bit start (no end): from `start` byte to the end of the string. */
function bitRangeFrom(totalBytes: number, args: string[]): [number, number] | null {
  let start = parseInteger(args[2]);
  if (start < 0) start = Math.max(0, totalBytes + start);
  if (start >= totalBytes) return null;
  return [start * 8, totalBytes * 8 - 1];
}
