import { idToString } from '@/modules/streams/streams.structure';

import PersistenceBytesCodec from './persistence.bytes.codec';
import PersistenceMessages from './persistence.messages';
import PersistenceObjectEncoderCodec from './persistence.object_encoder.codec';
import type { AofParseStep, RdbKeyEntry, Snapshot } from './persistence.types';

/** AOF text: RESP multibulk records, their parser, and the command-form base file of an AOF rewrite. */
export default class PersistenceAofService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Redis AOF_REWRITE_ITEMS_PER_CMD. */
  private static readonly ITEMS_PER_CMD = 64;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static pushBatched(out: string[], head: string[], itemsFlat: string[], width: number): void {
    const per = PersistenceAofService.ITEMS_PER_CMD * width;
    for (let i = 0; i < itemsFlat.length; i += per) out.push(PersistenceAofService.encodeAofCommand([...head, ...itemsFlat.slice(i, i + per)]));
  }

  private static rewriteKey(out: string[], key: string, e: RdbKeyEntry): void {
    const A = PersistenceAofService;
    const encode = A.encodeAofCommand;
    const v = e.value;
    switch (v.type) {
      case 'string':
        out.push(encode(['SET', key, v.value]));
        break;
      case 'list':
        A.pushBatched(out, ['RPUSH', key], v.value, 1);
        break;
      case 'set':
        A.pushBatched(out, ['SADD', key], [...v.value], 1);
        break;
      case 'zset':
        A.pushBatched(out, ['ZADD', key], v.value.entries.flatMap((z) => [A.formatG17(z.score), z.member]), 2);
        break;
      case 'hash': {
        A.pushBatched(out, ['HMSET', key], [...v.value].flat(), 2);
        // UNCERTAIN: Redis 7.4's rewriteHashObject field-TTL form; one HPEXPIREAT per field is equivalent.
        for (const [f, at] of e.fieldExpires ?? []) out.push(encode(['HPEXPIREAT', key, String(at), 'FIELDS', '1', f]));
        break;
      }
      case 'stream': {
        const s = v.value;
        const lastId = idToString(s.lastId);
        if (s.length) for (const entry of s.entries) out.push(encode(['XADD', key, idToString(entry.id), ...entry.fields]));
        else out.push(encode(['XADD', key, 'MAXLEN', '0', lastId, 'x', 'y']));
        out.push(encode(['XSETID', key, lastId, 'ENTRIESADDED', String(s.entriesAdded), 'MAXDELETEDID', idToString(s.maxDeletedId)]));
        for (const g of s.groups.values()) {
          out.push(encode(['XGROUP', 'CREATE', key, g.name, idToString(g.lastId), 'ENTRIESREAD', String(g.entriesRead ?? -1)]));
          for (const c of g.consumers.values()) {
            if (!c.pending.size) {
              out.push(encode(['XGROUP', 'CREATECONSUMER', key, g.name, c.name]));
              continue;
            }
            for (const p of c.pending.values()) {
              out.push(
                encode(['XCLAIM', key, g.name, c.name, '0', idToString(p.id), 'TIME', String(p.deliveryTime), 'RETRYCOUNT', String(p.deliveryCount), 'JUSTID', 'FORCE']),
              );
            }
          }
        }
        break;
      }
      case 'timeseries': {
        // A module value: no command rebuilds it exactly (rules, open compaction buckets), so the base file restores
        // redis-lite's own DUMP payload of it.
        const { type, body } = PersistenceObjectEncoderCodec.encodeObject(v);
        const payload = PersistenceBytesCodec.sealPayload(Buffer.concat([Buffer.from([type]), body]));
        out.push(encode(['RESTORE', key, '0', payload.toString('latin1'), 'REPLACE']));
        break;
      }
    }
    if (e.expireAt !== undefined) out.push(encode(['PEXPIREAT', key, String(e.expireAt)]));
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** One command as RESP multibulk (latin1 binary string), the AOF record format. */
  static encodeAofCommand(argv: readonly string[]): string {
    let out = `*${argv.length}\r\n`;
    for (const a of argv) out += `$${a.length}\r\n${a}\r\n`;
    return out;
  }

  /** Parses one AOF record starting at `pos`. `incomplete`: the file ends inside the record. */
  static parseAofCommand(text: string, pos: number): AofParseStep {
    const badFormat = { error: PersistenceMessages.AOF_BAD_FORMAT };
    const line = (from: number): { value: string; next: number } | null => {
      const nl = text.indexOf('\r\n', from);
      return nl < 0 ? null : { value: text.slice(from, nl), next: nl + 2 };
    };
    if (text[pos] !== '*') return badFormat;
    const head = line(pos + 1);
    if (!head) return { incomplete: true };
    const argc = Number(head.value);
    if (!Number.isInteger(argc) || argc < 1) return badFormat;
    let p = head.next;
    const argv: string[] = [];
    for (let i = 0; i < argc; i++) {
      if (p >= text.length) return { incomplete: true };
      if (text[p] !== '$') return badFormat;
      const len = line(p + 1);
      if (!len) return { incomplete: true };
      const n = Number(len.value);
      if (!Number.isInteger(n) || n < 0) return badFormat;
      if (len.next + n + 2 > text.length) return { incomplete: true };
      if (text.slice(len.next + n, len.next + n + 2) !== '\r\n') return badFormat;
      argv.push(text.slice(len.next, len.next + n));
      p = len.next + n + 2;
    }
    return { argv, next: p };
  }

  /** C printf("%.17g"): the score format Redis uses when rewriting ZADD into an AOF. */
  static formatG17(n: number): string {
    if (Number.isNaN(n)) return 'nan';
    if (n === Infinity) return 'inf';
    if (n === -Infinity) return '-inf';
    if (n === 0) return Object.is(n, -0) ? '-0' : '0';
    const exp = Number(n.toExponential(16).split('e')[1]);
    if (exp < -4 || exp >= 17) {
      const [mant, e] = n.toExponential(16).split('e');
      const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
      const ev = Number(e);
      return `${m}e${ev < 0 ? '-' : '+'}${String(Math.abs(ev)).padStart(2, '0')}`;
    }
    const fixed = n.toFixed(Math.max(0, 16 - exp));
    return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  }

  /** A base AOF in command form (aof-use-rdb-preamble no): FUNCTION LOADs, then per database SELECT + its keys. */
  static snapshotToAof(snap: Snapshot): string {
    const A = PersistenceAofService;
    const out: string[] = [];
    for (const code of snap.functions) out.push(A.encodeAofCommand(['FUNCTION', 'LOAD', code]));
    snap.dbs.forEach((db, i) => {
      if (!db.size) return;
      out.push(A.encodeAofCommand(['SELECT', String(i)]));
      for (const [key, e] of db) A.rewriteKey(out, key, e);
    });
    return out.join('');
  }
}
