import { z } from 'zod';

import { isInt64 } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, IntegerSchemaWith, KeySchema, ScanCursorSchema, firstIssue, reject } from '@/libs/schemas';
import { KeyScanOptionsSchema } from '@/libs/schemas/key-scan';
import { RandomCountSchema } from '@/libs/schemas/random-count';

import type { SetOperation } from './sets.enums';
import SetsMessages from './sets.messages';

/**
 * Argument grammar of the set commands. Each DTO parses the arguments after the command name (`args`), in command
 * order, so the first issue is the error Redis reports first. Checks that need the stored set stay in the services.
 */

// ============================================================================
// Shared Shapes
// ============================================================================

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

const KeyMemberDTO = z.tuple([KeySchema, z.string()]).transform(([key, member]) => ({ key, member }));

const KeyMembersDTO = z.tuple([KeySchema], z.string()).transform(([key, ...members]) => ({ key, members }));

// ============================================================================
// Member DTOs: SADD, SREM, SMEMBERS, SISMEMBER, SMISMEMBER, SCARD, SMOVE
// ============================================================================

export const SAddDTO = KeyMembersDTO;
export const SRemDTO = KeyMembersDTO;
export const SMembersDTO = KeyDTO;
export const SIsMemberDTO = KeyMemberDTO;
export const SMIsMemberDTO = KeyMembersDTO;
export const SCardDTO = KeyDTO;

export const SMoveDTO = z
  .tuple([KeySchema, KeySchema, z.string()])
  .transform(([source, destination, member]) => ({ source, destination, member }));

// ============================================================================
// Random DTOs: SPOP, SRANDMEMBER (parsed after the key is read)
// ============================================================================

/** SPOP key [count]: more arguments are a syntax error; the count must be a non-negative integer. */
export const SPopDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  if (rest.length > 1) return reject(ctx, RespMessages.SYNTAX);
  if (rest.length === 0) return { key, count: null };
  // any non-negative int64 (a count past the set's size pops everything)
  if (!isInt64(rest[0]) || rest[0].startsWith('-')) return reject(ctx, RespMessages.COUNT_POSITIVE);
  return { key, count: Number(rest[0]) };
});

/** SRANDMEMBER key [count]: a negative count may repeat members. */
export const SRandMemberDTO = z.tuple([KeySchema], z.string()).transform(([key, ...rest], ctx) => {
  if (rest.length > 1) return reject(ctx, RespMessages.SYNTAX);
  if (rest.length === 0) return { key, count: null };
  const count = RandomCountSchema.safeParse(rest[0]);
  return count.success ? { key, count: Number(count.data) } : reject(ctx, firstIssue(count.error));
});

// ============================================================================
// Algebra DTOs: SUNION, SINTER, SDIFF, their STORE forms, SINTERCARD
// ============================================================================

function CombineDTO(operation: SetOperation) {
  return z.array(KeySchema).transform((keys) => ({ keys, operation }));
}

function CombineStoreDTO(operation: SetOperation) {
  return z.tuple([KeySchema], KeySchema).transform(([destination, ...keys]) => ({ destination, keys, operation }));
}

export const SUnionDTO = CombineDTO('union');
export const SInterDTO = CombineDTO('inter');
export const SDiffDTO = CombineDTO('diff');
export const SUnionStoreDTO = CombineStoreDTO('union');
export const SInterStoreDTO = CombineStoreDTO('inter');
export const SDiffStoreDTO = CombineStoreDTO('diff');

const NumKeysSchema = IntegerSchemaWith(SetsMessages.NUMKEYS_POSITIVE).refine((n) => n > 0, {
  error: SetsMessages.NUMKEYS_POSITIVE,
});
const LimitSchema = IntegerSchemaWith(SetsMessages.LIMIT_NEGATIVE).refine((n) => n >= 0, {
  error: SetsMessages.LIMIT_NEGATIVE,
});

/** SINTERCARD numkeys key [key …] [LIMIT limit] */
export const SInterCardDTO = z.tuple([NumKeysSchema], z.string()).transform(([n, ...rest], ctx) => {
  const keys = rest.slice(0, n);
  if (keys.length < n) return reject(ctx, SetsMessages.NUMKEYS_GREATER);
  const options = rest.slice(n);
  if (!options.length) return { keys, limit: 0 };
  if (options.length !== 2 || options[0].toLowerCase() !== 'limit') return reject(ctx, RespMessages.SYNTAX);
  const limit = LimitSchema.safeParse(options[1]);
  return limit.success ? { keys, limit: limit.data } : reject(ctx, firstIssue(limit.error));
});

// ============================================================================
// Scan DTO
// ============================================================================

/** SSCAN key cursor …: the cursor alone, checked before the key is read. */
export const SScanCursorDTO = z.tuple([KeySchema, ScanCursorSchema], z.string()).transform(([key, cursor]) => ({ key, cursor }));

const SScanOptionsSchema = KeyScanOptionsSchema();

/** SSCAN key cursor [MATCH pattern] [COUNT n], parsed once the key is known to hold a set (no TYPE, no NOVALUES). */
export const SScanDTO = z.tuple([KeySchema, ScanCursorSchema], z.string()).transform(([key, cursor, ...options], ctx) => {
  const parsed = SScanOptionsSchema.safeParse(options);
  if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
  return { key, cursor, match: parsed.data.match, count: parsed.data.count };
});

// ============================================================================
// Type Exports
// ============================================================================

export type KeyInput = z.infer<typeof KeyDTO>;
export type KeyMemberInput = z.infer<typeof KeyMemberDTO>;
export type KeyMembersInput = z.infer<typeof KeyMembersDTO>;
export type SMoveInput = z.infer<typeof SMoveDTO>;
export type SPopInput = z.infer<typeof SPopDTO>;
export type SRandMemberInput = z.infer<typeof SRandMemberDTO>;
export type CombineInput = z.infer<typeof SUnionDTO>;
export type CombineStoreInput = z.infer<typeof SUnionStoreDTO>;
export type SInterCardInput = z.infer<typeof SInterCardDTO>;
export type SScanInput = z.infer<typeof SScanDTO>;
