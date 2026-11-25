import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { INT64_MAX, INT64_MIN, isInteger } from '@/libs/number';
import { RespMessages } from '@/libs/resp/messages';
import { Int64Schema, IntegerSchema, KeySchema, ValueSchema, firstIssue, reject } from '@/libs/schemas';

import { ScanCursorSchema, ScanOptionsSchema } from '@/modules/database/database.dto';

import { ExpireConditionEnum, ObjectSubcommandEnum } from './keys.enums';
import type { ExpireCondition, ObjectSubcommand } from './keys.enums';
import KeysMessages from './keys.messages';

/**
 * Argument grammar of the generic key commands. Each DTO parses the arguments after the command name (`args`), in
 * command order, so the first issue is the error Redis reports first. Checks that need the database or the server
 * (existing keys, the number of databases) stay in the services.
 */

// ============================================================================
// Shared Shapes
// ============================================================================

const KeyDTO = z.tuple([KeySchema]).transform(([key]) => ({ key }));

const KeysDTO = z.array(KeySchema).transform((keys) => ({ keys }));

const NoArgsDTO = z.tuple([]).transform(() => ({}));

/** A database index whose parse error is `message` (SWAPDB names which index is wrong). */
function DbIndexSchema(message: string) {
  return z
    .string()
    .refine(isInteger, { error: message })
    .transform((value) => Number(value));
}

// ============================================================================
// Keyspace DTOs: DEL, UNLINK, EXISTS, TOUCH, TYPE, RENAME, COPY, KEYS, SCAN, RANDOMKEY
// ============================================================================

export const DelDTO = KeysDTO;
export const ExistsDTO = KeysDTO;
export const TouchDTO = KeysDTO;
export const TypeDTO = KeyDTO;
export const RandomKeyDTO = NoArgsDTO;

export const RenameDTO = z.tuple([KeySchema, KeySchema]).transform(([source, destination]) => ({ source, destination }));

export const KeysPatternDTO = z.tuple([z.string()]).transform(([pattern]) => ({ pattern }));

/** SCAN cursor [MATCH pattern] [COUNT n] [TYPE type] */
export const ScanDTO = z.tuple([ScanCursorSchema], z.string()).transform(([cursor, ...options], ctx) => {
  const parsed = ScanOptionsSchema.safeParse(options);
  if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
  return { cursor, match: parsed.data.match, type: parsed.data.type, count: parsed.data.count };
});

type CopyParsed = {
  source: string;
  destination: string;
  replace: boolean;
  /** Every DB option, in order: the service checks each one exists, as Redis does while it reads them. */
  dbs: number[];
  /** A grammar error met after a DB option: reported only once the DB indexes before it are known to exist. */
  issue: string | null;
};

/** COPY source destination [DB index] [REPLACE] */
export const CopyDTO = z
  .tuple([KeySchema, KeySchema], z.string())
  .transform(([source, destination, ...options], ctx): CopyParsed => {
    let replace = false;
    const dbs: number[] = [];
    const fail = (message: string): CopyParsed =>
      dbs.length ? { source, destination, replace, dbs, issue: message } : reject(ctx, message);
    for (let i = 0; i < options.length; i++) {
      const opt = options[i].toLowerCase();
      if (opt === 'replace') replace = true;
      else if (opt === 'db' && i + 1 < options.length) {
        const index = IntegerSchema.safeParse(options[++i]);
        if (!index.success) return fail(firstIssue(index.error));
        dbs.push(index.data);
      } else return fail(RespMessages.SYNTAX);
    }
    return { source, destination, replace, dbs, issue: null };
  });

// ============================================================================
// Expiry DTOs: EXPIRE family, TTL family, PERSIST
// ============================================================================

/**
 * EXPIRE key amount [NX | XX | GT | LT]… → absolute expiry (ms). Options are any mix of the four conditions (NX with
 * another one, or GT with LT, is refused once all are read); an absolute time that overflows int64 is invalid.
 */
function ExpireDTO(command: string, unit: bigint, absolute: boolean) {
  const invalid = formatMessage(KeysMessages.INVALID_EXPIRE, { command });
  return z.tuple([KeySchema, Int64Schema], z.string()).transform(([key, amount, ...options], ctx) => {
    const conditions = new Set<ExpireCondition>();
    for (const given of options) {
      const condition = ExpireConditionEnum.safeParse(given.toLowerCase());
      if (!condition.success) return reject(ctx, formatMessage(KeysMessages.UNSUPPORTED_OPTION, { option: given }));
      conditions.add(condition.data);
    }
    const [nx, xx, gt, lt] = (['nx', 'xx', 'gt', 'lt'] as const).map((c) => conditions.has(c));
    if (nx && (xx || gt || lt)) return reject(ctx, KeysMessages.EXPIRE_NX_CONFLICT);
    if (gt && lt) return reject(ctx, KeysMessages.EXPIRE_GT_LT_CONFLICT);
    // Like Redis, a time that overflows int64 once converted to absolute ms is an error.
    const ms = amount * unit;
    const at = absolute ? ms : ms + BigInt(Date.now());
    if (ms > INT64_MAX || ms < INT64_MIN || at > INT64_MAX || at < INT64_MIN) return reject(ctx, invalid);
    return { key, at: Number(at), nx, xx, gt, lt };
  });
}

export const ExpireCmdDTO = ExpireDTO('expire', 1000n, false);
export const PExpireDTO = ExpireDTO('pexpire', 1n, false);
export const ExpireAtDTO = ExpireDTO('expireat', 1000n, true);
export const PExpireAtDTO = ExpireDTO('pexpireat', 1n, true);

/** TTL family: the reply unit (ms per unit) and whether the absolute time is wanted. */
function TtlDTO(unit: number, absolute: boolean) {
  return z.tuple([KeySchema]).transform(([key]) => ({ key, unit, absolute }));
}

export const TtlCmdDTO = TtlDTO(1000, false);
export const PTtlDTO = TtlDTO(1, false);
export const ExpireTimeDTO = TtlDTO(1000, true);
export const PExpireTimeDTO = TtlDTO(1, true);
export const PersistDTO = KeyDTO;

// ============================================================================
// OBJECT DTO
// ============================================================================

type ObjectParsed =
  | { help: true }
  /** `subcommand` is null for an unknown one: Redis looks the key up before refusing it. */
  | { help: false; key: string; subcommand: ObjectSubcommand | null; given: string };

/** OBJECT HELP | OBJECT <ENCODING | REFCOUNT | IDLETIME | FREQ> key */
export const ObjectDTO = z.tuple([z.string()], z.string()).transform(([given, ...rest], ctx): ObjectParsed => {
  const sub = given.toLowerCase();
  if (sub === 'help') return { help: true };
  if (rest.length !== 1) return reject(ctx, formatMessage(KeysMessages.OBJECT_ARITY, { subcommand: sub }));
  const subcommand = ObjectSubcommandEnum.safeParse(sub);
  return { help: false, key: rest[0], subcommand: subcommand.success ? subcommand.data : null, given };
});

// ============================================================================
// Database DTOs: MOVE, SWAPDB
// ============================================================================

export const MoveDTO = z.tuple([KeySchema, IntegerSchema]).transform(([key, db]) => ({ key, db }));

export const SwapDbDTO = z
  .tuple([DbIndexSchema(KeysMessages.INVALID_FIRST_DB_INDEX), DbIndexSchema(KeysMessages.INVALID_SECOND_DB_INDEX)])
  .transform(([first, second]) => ({ first, second }));

// ============================================================================
// SORT DTOs
// ============================================================================

/** SORT key [BY pattern] [LIMIT offset count] [GET pattern …] [ASC | DESC] [ALPHA] [STORE destination] */
function SortDTO(readOnly: boolean) {
  return z.tuple([KeySchema], z.string()).transform(([key, ...options], ctx) => {
    let by: string | null = null;
    let limit: [offset: number, count: number] | null = null;
    const gets: string[] = [];
    let desc = false;
    let alpha = false;
    let store: string | null = null;
    for (let i = 0; i < options.length; i++) {
      const opt = options[i].toLowerCase();
      if (opt === 'asc') desc = false;
      else if (opt === 'desc') desc = true;
      else if (opt === 'alpha') alpha = true;
      else if (opt === 'by' && i + 1 < options.length) by = options[++i];
      else if (opt === 'get' && i + 1 < options.length) gets.push(options[++i]);
      else if (opt === 'limit' && i + 2 < options.length) {
        const offset = IntegerSchema.safeParse(options[i + 1]);
        if (!offset.success) return reject(ctx, firstIssue(offset.error));
        const count = IntegerSchema.safeParse(options[i + 2]);
        if (!count.success) return reject(ctx, firstIssue(count.error));
        limit = [offset.data, count.data];
        i += 2;
      } else if (opt === 'store' && !readOnly && i + 1 < options.length) store = options[++i];
      else return reject(ctx, RespMessages.SYNTAX);
    }
    return { key, by, limit, gets, desc, alpha, store };
  });
}

export const SortCmdDTO = SortDTO(false);
export const SortRoDTO = SortDTO(true);

// ============================================================================
// DUMP / RESTORE DTOs
// ============================================================================

export const DumpDTO = KeyDTO;

const RestoreTtlSchema = IntegerSchema.refine((ttl) => ttl >= 0, { error: KeysMessages.INVALID_TTL });

/** RESTORE key ttl payload [REPLACE] [ABSTTL] [IDLETIME seconds] [FREQ frequency] */
export const RestoreDTO = z
  .tuple([KeySchema, RestoreTtlSchema, ValueSchema], z.string())
  .transform(([key, ttl, payload, ...options], ctx) => {
    let replace = false;
    let absolute = false;
    let idle: number | null = null;
    let freq: number | null = null;
    for (let i = 0; i < options.length; i++) {
      const opt = options[i].toLowerCase();
      if (opt === 'replace') replace = true;
      else if (opt === 'absttl') absolute = true;
      else if (opt === 'idletime') {
        const parsed = IntegerSchema.safeParse(options[++i] ?? '');
        if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
        if (parsed.data < 0) return reject(ctx, KeysMessages.INVALID_IDLETIME);
        idle = parsed.data;
      } else if (opt === 'freq') {
        const parsed = IntegerSchema.safeParse(options[++i] ?? '');
        if (!parsed.success) return reject(ctx, firstIssue(parsed.error));
        if (parsed.data < 0 || parsed.data > 255) return reject(ctx, KeysMessages.INVALID_FREQ);
        freq = parsed.data;
      } else return reject(ctx, RespMessages.SYNTAX);
    }
    return { key, ttl, payload, replace, absolute, idle, freq };
  });

// ============================================================================
// Type Exports
// ============================================================================

export type KeyInput = z.infer<typeof KeyDTO>;
export type KeysInput = z.infer<typeof KeysDTO>;
export type RenameInput = z.infer<typeof RenameDTO>;
export type KeysPatternInput = z.infer<typeof KeysPatternDTO>;
export type ScanInput = z.infer<typeof ScanDTO>;
export type CopyInput = z.infer<typeof CopyDTO>;
export type ExpireInput = z.infer<typeof ExpireCmdDTO>;
export type TtlInput = z.infer<typeof TtlCmdDTO>;
export type ObjectInput = z.infer<typeof ObjectDTO>;
export type MoveInput = z.infer<typeof MoveDTO>;
export type SwapDbInput = z.infer<typeof SwapDbDTO>;
export type SortInput = z.infer<typeof SortCmdDTO>;
export type RestoreInput = z.infer<typeof RestoreDTO>;
