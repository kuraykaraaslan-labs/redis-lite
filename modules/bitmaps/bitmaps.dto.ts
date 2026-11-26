import { z } from 'zod';

import { isInteger } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import { Int64Schema, IntegerSchemaWith, KeySchema, firstIssue, reject } from '@/libs/schemas';
import type { Parsed } from '@/libs/schemas';

import { BitOpEnum, BitfieldOpEnum, OverflowPolicyEnum, RangeUnitEnum } from './bitmaps.enums';
import type { OverflowPolicy } from './bitmaps.enums';
import BitmapsMessages from './bitmaps.messages';
import type { BitRangeArgs, BitfieldStep, DeferredIssue, FieldType } from './bitmaps.types';

/**
 * Argument grammar of the bitmap commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. The proto-max-bulk-len limit on bit offsets is config,
 * so the services check it; grammar errors Redis meets after such a check are carried as a deferred `issue`.
 */

// ============================================================================
// Shared Grammar
// ============================================================================

/** A non-negative bit offset (the upper limit is config: checked by the services). */
const BitOffsetSchema = IntegerSchemaWith(BitmapsMessages.BIT_OFFSET).refine((n) => n >= 0, { error: BitmapsMessages.BIT_OFFSET });

/**
 * An int64 range index → number. Indexes past ±2^53 behave like ±2^53 against any string length, so the clamping
 * keeps every result while the services work with plain numbers.
 */
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const RangeIndexSchema = Int64Schema.transform((n) => Number(n > SAFE ? SAFE : n < -SAFE ? -SAFE : n));

/**
 * `[start end [BYTE | BIT]]` (BITCOUNT, BITPOS with an end): a start without end, or anything after the unit, is a
 * syntax error (checked before the indexes are parsed).
 */
function readRange(rest: string[]): Parsed<BitRangeArgs | null> {
  if (rest.length === 0) return { ok: true, value: null };
  if (rest.length === 1 || rest.length > 3) return { ok: false, error: RespMessages.SYNTAX };
  const start = RangeIndexSchema.safeParse(rest[0]);
  if (!start.success) return { ok: false, error: firstIssue(start.error) };
  const end = RangeIndexSchema.safeParse(rest[1]);
  if (!end.success) return { ok: false, error: firstIssue(end.error) };
  const unit = RangeUnitEnum.safeParse((rest[2] ?? 'byte').toLowerCase());
  if (!unit.success) return { ok: false, error: RespMessages.SYNTAX };
  return { ok: true, value: { start: start.data, end: end.data, unit: unit.data } };
}

/** `i<bits>` (1–64) or `u<bits>` (1–63), any case. */
function readFieldType(raw: string): Parsed<FieldType> {
  const m = /^([iu])(\d+)$/i.exec(raw);
  if (!m) return { ok: false, error: BitmapsMessages.BITFIELD_TYPE };
  const signed = m[1].toLowerCase() === 'i';
  const bits = Number(m[2]);
  if (bits < 1 || (signed && bits > 64) || (!signed && bits > 63)) return { ok: false, error: BitmapsMessages.BITFIELD_TYPE };
  return { ok: true, value: { signed, bits } };
}

/** A BITFIELD offset: `n` bits, or `#n` = n times the type width; negative is refused. */
function readFieldOffset(raw: string, type: FieldType): Parsed<number> {
  const multiply = raw.startsWith('#');
  const digits = multiply ? raw.slice(1) : raw;
  if (!isInteger(digits)) return { ok: false, error: BitmapsMessages.BIT_OFFSET };
  const n = Number(digits);
  const offset = multiply ? n * type.bits : n;
  return offset < 0 ? { ok: false, error: BitmapsMessages.BIT_OFFSET } : { ok: true, value: offset };
}

// ============================================================================
// Bit DTOs: GETBIT, SETBIT, BITCOUNT, BITPOS
// ============================================================================

export const GetBitDTO = z.tuple([KeySchema, BitOffsetSchema]).transform(([key, offset]) => ({ key, offset }));

/** SETBIT key offset 0|1: the offset's limit (config) is checked before the bit, so a bad bit is a deferred issue. */
export const SetBitDTO = z.tuple([KeySchema, BitOffsetSchema, z.string()]).transform(([key, offset, raw]) => {
  const valid = raw === '0' || raw === '1';
  return { key, offset, bit: valid ? Number(raw) : 0, issue: valid ? null : BitmapsMessages.BIT_VALUE };
});

/** BITCOUNT key [start end [BYTE | BIT]] (parsed after the key is read). */
export const BitCountDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  const range = readRange(rest);
  return range.ok ? { key, range: range.value } : reject(ctx, range.error);
});

/** BITPOS's bit, checked before the key is read: an integer first, then 0 or 1. */
export const BitPosBitDTO = z.tuple([KeySchema, Int64Schema], z.string()).transform(([key, bit], ctx) => {
  return bit === 0n || bit === 1n ? { key, bit: Number(bit) } : reject(ctx, BitmapsMessages.BITPOS_BIT);
});

/** BITPOS key bit [start [end [BYTE | BIT]]] (the range is parsed after the key is read and found non-empty). */
export const BitPosDTO = z.tuple([KeySchema, z.string()], z.string()).transform(([key, raw, ...rest], ctx) => {
  const bit = Number(raw);
  if (rest.length === 1) {
    const start = RangeIndexSchema.safeParse(rest[0]);
    if (!start.success) return reject(ctx, firstIssue(start.error));
    return { key, bit, range: { start: start.data, end: null, unit: 'byte' } as BitRangeArgs, explicitEnd: false };
  }
  const range = readRange(rest);
  return range.ok ? { key, bit, range: range.value, explicitEnd: rest.length > 1 } : reject(ctx, range.error);
});

// ============================================================================
// BITOP DTO
// ============================================================================

/** BITOP operation destkey key [key …]: the source count is checked by the service, after the sources are read. */
export const BitOpDTO = z.tuple([z.string(), KeySchema], KeySchema).transform(([given, destination, ...sources], ctx) => {
  const operation = BitOpEnum.safeParse(given.toLowerCase());
  return operation.success ? { operation: operation.data, destination, sources } : reject(ctx, RespMessages.SYNTAX);
});

// ============================================================================
// BITFIELD DTOs
// ============================================================================

type BitfieldParsed = { key: string; steps: BitfieldStep[]; issue: DeferredIssue | null };

/**
 * BITFIELD key [GET type offset] [SET type offset value] [INCRBY type offset increment] [OVERFLOW WRAP|SAT|FAIL] …
 * Subcommands are read left to right. An error before any offset was read is a plain validation error; after one, it
 * is deferred (see DeferredIssue), with the offset of the failing subcommand when it was already read.
 */
function BitfieldDTO(readOnly: boolean) {
  return z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx): BitfieldParsed => {
    const steps: BitfieldStep[] = [];
    let policy: OverflowPolicy = 'wrap';
    const fail = (message: string, offset: number | null = null): BitfieldParsed =>
      steps.length || offset !== null ? { key, steps, issue: { message, offset } } : reject(ctx, message);
    for (let i = 0; i < rest.length; i++) {
      const name = rest[i].toLowerCase();
      // OVERFLOW without its mode is a syntax error, like any subcommand missing arguments
      if (name === 'overflow' && i + 1 < rest.length) {
        const given = OverflowPolicyEnum.safeParse(rest[++i].toLowerCase());
        if (!given.success) return fail(BitmapsMessages.BITFIELD_OVERFLOW);
        policy = given.data;
        continue;
      }
      const op = BitfieldOpEnum.safeParse(name);
      if (!op.success) return fail(RespMessages.SYNTAX);
      if (readOnly && op.data !== 'get') return fail(BitmapsMessages.BITFIELD_RO_GET_ONLY);
      // GET takes type + offset, SET/INCRBY also a value: missing arguments are a syntax error.
      if (i + (op.data === 'get' ? 2 : 3) >= rest.length) return fail(RespMessages.SYNTAX);
      const type = readFieldType(rest[++i]);
      if (!type.ok) return fail(type.error);
      const offset = readFieldOffset(rest[++i], type.value);
      if (!offset.ok) return fail(offset.error);
      let value: bigint | null = null;
      if (op.data !== 'get') {
        const parsed = Int64Schema.safeParse(rest[++i]);
        if (!parsed.success) return fail(firstIssue(parsed.error), offset.value);
        value = parsed.data;
      }
      steps.push({ op: op.data, type: type.value, offset: offset.value, value, policy });
    }
    return { key, steps, issue: null };
  });
}

export const BitfieldCmdDTO = BitfieldDTO(false);
export const BitfieldRoDTO = BitfieldDTO(true);

// ============================================================================
// Type Exports
// ============================================================================

export type GetBitInput = z.infer<typeof GetBitDTO>;
export type SetBitInput = z.infer<typeof SetBitDTO>;
export type BitCountInput = z.infer<typeof BitCountDTO>;
export type BitPosBitInput = z.infer<typeof BitPosBitDTO>;
export type BitPosInput = z.infer<typeof BitPosDTO>;
export type BitOpInput = z.infer<typeof BitOpDTO>;
export type BitfieldInput = z.infer<typeof BitfieldCmdDTO>;
