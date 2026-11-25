import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import type { Reply } from '../resp';
import { OK } from '../resp';
import type { DecodedObject, RdbOptions } from '../store/rdb';
import { dumpPayload, restorePayloadEx } from '../store/rdb';
import { parseInteger, toFloat } from '../util';
import { hashFieldExpires, setHashFieldExpires } from './hashes';
import type { CommandContext, CommandSpec } from './types';
import { keysAt } from './types';

// ---- SORT -----------------------------------------------------------------------------------------------------

/** SORT's pattern lookup: `#` = the element itself, `key*` = string value, `key*->field` = hash field. */
function lookupPattern(ctx: CommandContext, pattern: string, element: string): string | null {
  if (pattern === '#') return element;
  const star = pattern.indexOf('*');
  if (star < 0) return null;
  const arrow = pattern.indexOf('->', star);
  const keyPattern = arrow > 0 ? pattern.slice(0, arrow) : pattern;
  const key = keyPattern.replace('*', element);
  const v = ctx.db.lookup(key);
  if (!v) return null;
  if (arrow > 0) return v.type === 'hash' ? (v.value.get(pattern.slice(arrow + 2)) ?? null) : null;
  return v.type === 'string' ? v.value : null;
}

function sort(ctx: CommandContext, args: string[], readOnly: boolean): Reply {
  const key = args[0];
  let by: string | null = null;
  let limit: [number, number] | null = null;
  const gets: string[] = [];
  let desc = false;
  let alpha = false;
  let store: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    if (opt === 'asc') desc = false;
    else if (opt === 'desc') desc = true;
    else if (opt === 'alpha') alpha = true;
    else if (opt === 'by' && i + 1 < args.length) by = args[++i];
    else if (opt === 'get' && i + 1 < args.length) gets.push(args[++i]);
    else if (opt === 'limit' && i + 2 < args.length) {
      limit = [parseInteger(args[i + 1]), parseInteger(args[i + 2])];
      i += 2;
    } else if (opt === 'store' && !readOnly && i + 1 < args.length) store = args[++i];
    else throw new CommandError(RespMessages.SYNTAX);
  }
  const v = ctx.db.lookup(key);
  let elements: string[] = [];
  if (v) {
    if (v.type === 'list') elements = [...v.value];
    else if (v.type === 'set') elements = [...v.value];
    else if (v.type === 'zset') elements = v.value.entries.map((e) => e.member);
    else throw new CommandError(RespMessages.WRONGTYPE);
  }
  const noSort = by !== null && !by.includes('*');
  // BY nosort on a sorted set keeps the zset order; DESC walks it backwards, as Redis does.
  if (noSort && v?.type === 'zset' && desc) elements.reverse();
  if (!noSort) {
    const weights = new Map<string, number | string | null>();
    for (const e of elements) {
      const raw = by === null ? e : lookupPattern(ctx, by, e);
      if (alpha) weights.set(e, raw);
      else if (raw === null) weights.set(e, 0);
      else {
        const n = toFloat(raw);
        if (n === null) throw new CommandError("ERR One or more scores can't be converted into double");
        weights.set(e, n);
      }
    }
    elements.sort((a, b) => {
      const wa = weights.get(a) ?? null;
      const wb = weights.get(b) ?? null;
      let cmp: number;
      if (alpha) {
        const sa = String(wa ?? '');
        const sb = String(wb ?? '');
        cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
      } else cmp = (wa as number) - (wb as number);
      if (cmp === 0) cmp = a < b ? -1 : a > b ? 1 : 0;
      return desc ? -cmp : cmp;
    });
  }
  if (limit) {
    const [offset, count] = limit;
    const start = Math.max(0, offset);
    elements = count < 0 ? elements.slice(start) : elements.slice(start, start + count);
  }
  const out: Array<string | null> = gets.length ? elements.flatMap((e) => gets.map((g) => lookupPattern(ctx, g, e))) : elements;
  if (store !== null) {
    const values = out.map((x) => x ?? '');
    if (values.length) ctx.db.set(store, { type: 'list', value: values });
    else ctx.db.remove(store);
    ctx.server.touch(ctx.client.dbIndex, store);
    return values.length;
  }
  return out;
}

// ---- DUMP / RESTORE -------------------------------------------------------------------------------------------

/** Live encoding thresholds, so DUMP picks the same object encoding Redis would. */
export function rdbOptions(ctx: CommandContext): Partial<RdbOptions> {
  const c = ctx.server.config;
  return {
    hashMaxListpackEntries: c.num('hash-max-listpack-entries'),
    hashMaxListpackValue: c.num('hash-max-listpack-value'),
    setMaxIntsetEntries: c.num('set-max-intset-entries'),
    setMaxListpackEntries: c.num('set-max-listpack-entries'),
    setMaxListpackValue: c.num('set-max-listpack-value'),
    zsetMaxListpackEntries: c.num('zset-max-listpack-entries'),
    zsetMaxListpackValue: c.num('zset-max-listpack-value'),
    listMaxListpackSize: c.num('list-max-listpack-size'),
    streamNodeMaxEntries: c.num('stream-node-max-entries'),
    streamNodeMaxBytes: c.num('stream-node-max-bytes'),
  };
}

/** Maps codec errors to the Redis error replies. */
export function rdbError(error: unknown): CommandError {
  const msg = (error as Error).message;
  if (msg.includes('version or checksum')) return new CommandError('ERR DUMP payload version or checksum are wrong');
  return new CommandError('ERR Bad data format');
}

export const extraKeyCommands: CommandSpec[] = [
  { name: 'sort', arity: -2, flags: { write: true }, keys: keysAt(0), handler: (ctx, args) => sort(ctx, args, false) },
  { name: 'sort_ro', arity: -2, handler: (ctx, args) => sort(ctx, args, true) },
  {
    name: 'move',
    arity: 3,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const index = parseInteger(args[1]);
      const target = ctx.server.databases[index];
      if (!target) throw new CommandError(RespMessages.DB_INDEX);
      if (index === ctx.client.dbIndex) throw new CommandError('ERR source and destination objects are the same');
      const v = ctx.db.lookup(args[0]);
      if (!v || target.has(args[0])) return 0;
      const at = ctx.db.getExpire(args[0]);
      ctx.db.remove(args[0]);
      target.set(args[0], v);
      if (at !== undefined) target.setExpire(args[0], at);
      ctx.server.touch(index, args[0]);
      return 1;
    },
  },
  {
    name: 'swapdb',
    arity: 3,
    flags: { write: true },
    handler: (ctx, args) => {
      const a = parseInteger(args[0], 'ERR invalid first DB index');
      const b = parseInteger(args[1], 'ERR invalid second DB index');
      if (!ctx.server.databases[a] || !ctx.server.databases[b]) throw new CommandError(RespMessages.DB_INDEX);
      if (a !== b) ctx.server.swapDatabases(a, b);
      return OK;
    },
  },
  {
    name: 'dump',
    arity: 2,
    handler: (ctx, args) => {
      const v = ctx.db.lookup(args[0]);
      if (!v) return null;
      const ttl = v.type === 'hash' ? hashFieldExpires(v.value) : undefined;
      return dumpPayload(v, rdbOptions(ctx), ttl).toString('latin1');
    },
  },
  {
    name: 'restore',
    arity: -4,
    flags: { write: true },
    keys: keysAt(0),
    handler: (ctx, args) => {
      const [key, rawTtl, payload] = args;
      const ttl = parseInteger(rawTtl);
      if (ttl < 0) throw new CommandError('ERR Invalid TTL value, must be >= 0');
      let replace = false;
      let absolute = false;
      let idle: number | null = null;
      let freq: number | null = null;
      for (let i = 3; i < args.length; i++) {
        const opt = args[i].toLowerCase();
        if (opt === 'replace') replace = true;
        else if (opt === 'absttl') absolute = true;
        else if (opt === 'idletime') {
          idle = parseInteger(args[++i] ?? '');
          if (idle < 0) throw new CommandError('ERR Invalid IDLETIME value, must be >= 0');
        } else if (opt === 'freq') {
          freq = parseInteger(args[++i] ?? '');
          if (freq < 0 || freq > 255) throw new CommandError('ERR Invalid FREQ value, must be >= 0 and <= 255');
        }
        else throw new CommandError(RespMessages.SYNTAX);
      }
      if (ctx.db.has(key) && !replace) throw new CommandError('BUSYKEY Target key name already exists.');
      let decoded: DecodedObject;
      try {
        decoded = restorePayloadEx(Buffer.from(payload, 'latin1'));
      } catch (error) {
        throw rdbError(error);
      }
      const value = decoded.value;
      const at = ttl === 0 ? undefined : absolute ? ttl : Date.now() + ttl;
      if (at !== undefined && at <= Date.now()) {
        ctx.db.remove(key);
        return OK;
      }
      ctx.db.set(key, value);
      if (value.type === 'hash' && decoded.fieldExpires) setHashFieldExpires(value.value, decoded.fieldExpires);
      if (at !== undefined) ctx.db.setExpire(key, at);
      // IDLETIME applies under LRU-style policies, FREQ under LFU, like Redis's objectSetLRUOrLFU.
      if (idle !== null && !ctx.server.config.lfu) ctx.db.setIdle(key, idle);
      if (freq !== null && ctx.server.config.lfu) ctx.db.setFrequency(key, freq);
      return OK;
    },
  },
];
