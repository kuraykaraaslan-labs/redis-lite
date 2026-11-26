/**
 * RESP helpers of the differential harness: command encoding, a redis-cli-like command tokenizer, reply framing and a
 * small reply tree (for normalisers that reorder or mask parts of a reply). Bytes are carried as latin1 strings, so
 * every byte value survives unchanged and replies can be compared byte for byte.
 */

/** One parsed RESP value. `raw` is the exact bytes of the value (children included). */
export interface RespNode {
  type: string;
  /** The header line without the type byte (`5` for `$5`, `OK` for `+OK`). */
  head: string;
  raw: string;
  /** Aggregate children (map / attribute: key, value, key, value…). */
  children: RespNode[];
}

const AGGREGATES = new Set(['*', '~', '>', '%', '|']);
const BLOBS = new Set(['$', '!', '=']);

/** Encodes one command as a RESP array of bulk strings. */
export function encodeCommand(args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a, 'latin1')}\r\n${a}\r\n`).join('')}`;
}

/**
 * Splits a command line like redis-cli does: whitespace separates arguments, `"…"` allows spaces and the escapes
 * \n \r \t \b \a \\ \" \xHH, `'…'` is literal. An empty quoted string is an empty argument.
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let arg = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          const e = line[i + 1];
          if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            arg += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          arg += { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' }[e] ?? e;
          i += 2;
          continue;
        }
        arg += line[i++];
      }
      i++;
    } else if (line[i] === "'") {
      const end = line.indexOf("'", i + 1);
      arg = line.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? line.length : end + 1;
    } else {
      while (i < line.length && !/\s/.test(line[i])) arg += line[i++];
    }
    out.push(arg);
  }
  return out;
}

/** End offset of the RESP value starting at `i`, or -1 when the bytes stop before it ends. */
export function respEnd(buf: string, i: number): number {
  if (i >= buf.length) return -1;
  const eol = buf.indexOf('\r\n', i);
  if (eol < 0) return -1;
  const type = buf[i];
  const head = buf.slice(i + 1, eol);
  let next = eol + 2;
  if (BLOBS.has(type)) {
    const len = Number(head);
    if (len < 0) return next;
    return buf.length >= next + len + 2 ? next + len + 2 : -1;
  }
  if (AGGREGATES.has(type)) {
    const n = Number(head);
    const count = Math.max(n, 0) * (type === '%' || type === '|' ? 2 : 1);
    for (let k = 0; k < count; k++) {
      next = respEnd(buf, next);
      if (next < 0) return -1;
    }
    // an attribute (|) is followed by the value it annotates: both form one reply
    return type === '|' ? respEnd(buf, next) : next;
  }
  return next; // simple types: + - : _ # , (
}

/** Parses the whole RESP value at `i` (the bytes must be complete). */
export function parseResp(buf: string, i = 0): { node: RespNode; end: number } {
  const eol = buf.indexOf('\r\n', i);
  const type = buf[i];
  const head = buf.slice(i + 1, eol);
  let next = eol + 2;
  const children: RespNode[] = [];
  if (BLOBS.has(type)) {
    const len = Number(head);
    if (len >= 0) next += len + 2;
  } else if (AGGREGATES.has(type)) {
    const count = Math.max(Number(head), 0) * (type === '%' || type === '|' ? 2 : 1);
    for (let k = 0; k < count; k++) {
      const child = parseResp(buf, next);
      children.push(child.node);
      next = child.end;
    }
  }
  return { node: { type, head, raw: buf.slice(i, next), children }, end: next };
}

/** Rebuilds the bytes of a node whose children may have been replaced or reordered. */
export function serialize(node: RespNode): string {
  if (!AGGREGATES.has(node.type) || Number(node.head) < 0) return node.raw;
  const pairs = node.type === '%' || node.type === '|';
  const count = pairs ? node.children.length / 2 : node.children.length;
  return `${node.type}${count}\r\n${node.children.map(serialize).join('')}`;
}

/** The payload of a bulk / verbatim / simple node (verbatim strings without their `txt:` prefix). */
export function payload(node: RespNode): string {
  if (BLOBS.has(node.type)) {
    const body = node.raw.slice(node.raw.indexOf('\r\n') + 2, -2);
    return node.type === '=' ? body.slice(4) : body;
  }
  return node.head;
}

/** A node with the same type as `node` (bulk or verbatim) holding `text`. */
export function withPayload(node: RespNode, text: string): RespNode {
  if (node.type === '=') {
    const body = `txt:${text}`;
    return { ...node, head: String(body.length), raw: `=${body.length}\r\n${body}\r\n`, children: [] };
  }
  if (BLOBS.has(node.type)) return { ...node, head: String(text.length), raw: `${node.type}${text.length}\r\n${text}\r\n`, children: [] };
  return { ...node, head: text, raw: `${node.type}${text}\r\n`, children: [] };
}

export function isAggregate(node: RespNode): boolean {
  return AGGREGATES.has(node.type);
}

/** Printable form of raw bytes (JSON string escapes; non-ASCII bytes as \u00XX). */
export function show(bytes: string): string {
  return JSON.stringify(bytes);
}
