import PersistenceMessages from './persistence.messages';
import type { AofInfo, AofManifest } from './persistence.types';

/** The AOF manifest (Redis 7+ multi-part AOF): parsing, formatting, and the sdssplitargs() it is written in. */
export default class PersistenceManifestService {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly SPLIT_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };
  private static readonly REPR_ESCAPES: Readonly<Record<string, string>> = {
    '\\': '\\\\',
    '"': '\\"',
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
    '\x07': '\\a',
    '\b': '\\b',
  };

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** sdscatrepr() when the name needs it (spaces, quotes, non-printables), as getAofManifestAsString does. */
  private static manifestName(name: string): string {
    if (!/[\s"'\\\x00-\x1f\x7f-\xff]/.test(name)) return name;
    const esc = PersistenceManifestService.REPR_ESCAPES;
    return `"${name.replace(/[\\"\x00-\x1f\x7f-\xff]/g, (c) => esc[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}"`;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** sdssplitargs(): space-separated words, "double quoted" with C escapes or 'single quoted'. */
  static splitArgs(line: string): string[] | null {
    const out: string[] = [];
    let i = 0;
    while (i < line.length) {
      while (i < line.length && /\s/.test(line[i])) i++;
      if (i >= line.length) break;
      let cur = '';
      if (line[i] === '"') {
        i++;
        let closed = false;
        while (i < line.length) {
          const c = line[i];
          if (c === '\\' && i + 1 < line.length) {
            const nx = line[i + 1];
            if (nx === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
              cur += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
              i += 4;
              continue;
            }
            cur += PersistenceManifestService.SPLIT_ESCAPES[nx] ?? nx;
            i += 2;
          } else if (c === '"') {
            closed = true;
            i++;
            break;
          } else {
            cur += c;
            i++;
          }
        }
        if (!closed || (i < line.length && !/\s/.test(line[i]))) return null;
      } else if (line[i] === "'") {
        i++;
        let closed = false;
        while (i < line.length) {
          if (line[i] === '\\' && line[i + 1] === "'") {
            cur += "'";
            i += 2;
          } else if (line[i] === "'") {
            closed = true;
            i++;
            break;
          } else cur += line[i++];
        }
        if (!closed) return null;
      } else {
        while (i < line.length && !/\s/.test(line[i])) cur += line[i++];
      }
      out.push(cur);
    }
    return out;
  }

  static emptyManifest(): AofManifest {
    return { base: null, incr: [], history: [], baseSeq: 0, incrSeq: 0 };
  }

  /** Parses a manifest; throws 'Invalid AOF manifest file format' like Redis. */
  static parseAofManifest(text: string): AofManifest {
    const m = PersistenceManifestService.emptyManifest();
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const args = PersistenceManifestService.splitArgs(line);
      if (!args || args.length % 2) throw new Error(PersistenceMessages.MANIFEST_INVALID);
      const kv = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) kv.set(args[i], args[i + 1]);
      const name = kv.get('file');
      const seq = Number(kv.get('seq'));
      const type = kv.get('type');
      if (!name || !Number.isInteger(seq) || (type !== 'b' && type !== 'h' && type !== 'i')) throw new Error(PersistenceMessages.MANIFEST_INVALID);
      const info: AofInfo = { name, seq, type };
      if (type === 'b') {
        if (m.base) throw new Error(PersistenceMessages.MANIFEST_DUPLICATE_BASE);
        m.base = info;
        m.baseSeq = seq;
      } else if (type === 'h') m.history.push(info);
      else {
        if (seq <= m.incrSeq) throw new Error(PersistenceMessages.MANIFEST_NON_MONOTONIC);
        m.incr.push(info);
        m.incrSeq = seq;
      }
    }
    return m;
  }

  /** getAofManifestAsString: base, then history, then incr files. */
  static formatAofManifest(m: AofManifest): string {
    const line = (i: AofInfo): string => `file ${PersistenceManifestService.manifestName(i.name)} seq ${i.seq} type ${i.type}\n`;
    return [...(m.base ? [m.base] : []), ...m.history, ...m.incr].map(line).join('');
  }
}
