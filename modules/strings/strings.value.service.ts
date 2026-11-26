import { AppError } from '@/libs/app-error';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import type { GetExInput, KeyInput, KeyValueInput, MGetInput, MSetInput, SetExInput, SetInput } from './strings.dto';

/** Whole-value reads and writes: GET, SET and its variants, GETEX, MGET, MSET, MSETNX. */
export default class StringsValueService {
  /** GET: the string value, or null when the key does not exist (WRONGTYPE for other types). */
  static get(ctx: CommandContext, { key }: KeyInput): string | null {
    return ctx.db.get(key, 'string') ?? null;
  }

  /** SET with its options. The GET option's type check runs after the options were parsed, as in Redis. */
  static set(ctx: CommandContext, { key, value, condition, get, keepTtl, expireAt }: SetInput): Reply {
    const old = get ? (ctx.db.get(key, 'string') ?? null) : null;
    const exists = ctx.db.has(key);
    if ((condition === 'NX' && exists) || (condition === 'XX' && !exists)) {
      ctx.noop = true;
      return get ? old : null;
    }
    ctx.db.set(key, { type: 'string', value }, keepTtl);
    if (expireAt !== undefined) ctx.db.setExpire(key, expireAt);
    return get ? old : OK;
  }

  /** SETEX / PSETEX: SET with a mandatory expiry. */
  static setEx(ctx: CommandContext, { key, expireAt, value }: SetExInput): Reply {
    ctx.db.set(key, { type: 'string', value });
    ctx.db.setExpire(key, expireAt);
    return OK;
  }

  /** SETNX: 1 when the key was set, 0 when it already existed (whatever its type). */
  static setNx(ctx: CommandContext, { key, value }: KeyValueInput): number {
    if (ctx.db.has(key)) return 0;
    ctx.db.set(key, { type: 'string', value });
    return 1;
  }

  /** GETSET: sets the value (clearing the TTL) and returns the old one. */
  static getSet(ctx: CommandContext, { key, value }: KeyValueInput): string | null {
    const old = ctx.db.get(key, 'string') ?? null;
    ctx.db.set(key, { type: 'string', value });
    return old;
  }

  /** GETDEL: returns the value and deletes the key. */
  static getDel(ctx: CommandContext, { key }: KeyInput): string | null {
    const value = ctx.db.get(key, 'string');
    if (value === undefined) return null;
    ctx.db.remove(key);
    return value;
  }

  /**
   * GETEX on an existing key (`value` read after the option syntax, see the commands layer): validates the expiry value
   * only now, as Redis does, then applies PERSIST or the new expiry.
   */
  static getEx(ctx: CommandContext, { key, persist, expireAt }: GetExInput, value: string): string {
    if (expireAt && !expireAt.ok) throw new AppError(expireAt.error);
    if (persist) ctx.db.persist(key);
    else if (expireAt) ctx.db.setExpire(key, expireAt.value);
    return value;
  }

  /** MGET: null for missing keys and for keys of another type (never WRONGTYPE). */
  static mGet(ctx: CommandContext, { keys }: MGetInput): Array<string | null> {
    return keys.map((key) => {
      const entry = ctx.db.lookup(key);
      return entry?.type === 'string' ? entry.value : null;
    });
  }

  static mSet(ctx: CommandContext, { pairs }: MSetInput): Reply {
    for (const [key, value] of pairs) ctx.db.set(key, { type: 'string', value });
    return OK;
  }

  /** MSETNX: all-or-nothing; 0 (and nothing set) when any key exists. */
  static mSetNx(ctx: CommandContext, { pairs }: MSetInput): number {
    if (pairs.some(([key]) => ctx.db.has(key))) return 0;
    for (const [key, value] of pairs) ctx.db.set(key, { type: 'string', value });
    return 1;
  }
}
