import {
  formatDouble,
  NULL_ARRAY,
  RespBigNumber,
  RespBool,
  RespDouble,
  RespError,
  RespMap,
  RespPairs,
  RespPush,
  RespSet,
  RespVerbatim,
  Status,
} from './reply';
import type { Protocol, Reply } from './reply';

/**
 * Reply encoder: a reply value → its RESP2 / RESP3 bytes.
 *
 * The reply is built as one latin1 string (V8 concatenates into ropes without copying) and converted to a Buffer once.
 * The common shapes (integer, bulk string, null, status) take a direct path without recursion.
 */

// ============================================================================
// Encoding
// ============================================================================

const CRLF = '\r\n';
const LINE_BREAKS = /[\r\n]+/g;

/** `$<len>\r\n<bytes>\r\n` */
function bulk(text: string): string {
  return '$' + text.length + CRLF + text + CRLF;
}

/** Errors are one line: CR / LF runs become a space. */
function errorLine(message: string): string {
  const oneLine = message.indexOf('\r') < 0 && message.indexOf('\n') < 0 ? message : message.replace(LINE_BREAKS, ' ');
  return '-' + oneLine + CRLF;
}

function writeAll(items: readonly Reply[], proto: Protocol): string {
  let out = '';
  for (let i = 0; i < items.length; i++) out += write(items[i], proto);
  return out;
}

function writePairs(pairs: ReadonlyArray<readonly [Reply, Reply]>, proto: Protocol, nested: boolean): string {
  let out = '';
  for (let i = 0; i < pairs.length; i++) {
    if (nested) out += '*2\r\n';
    out += write(pairs[i][0], proto) + write(pairs[i][1], proto);
  }
  return out;
}

function write(reply: Reply, proto: Protocol): string {
  if (typeof reply === 'string') return bulk(reply);
  if (typeof reply === 'number') return ':' + Math.trunc(reply) + CRLF;
  if (reply === null) return proto === 3 ? '_\r\n' : '$-1\r\n';
  if (Array.isArray(reply)) return '*' + reply.length + CRLF + writeAll(reply, proto);
  if (reply === NULL_ARRAY) return proto === 3 ? '_\r\n' : '*-1\r\n';
  if (typeof reply === 'bigint') return ':' + reply.toString() + CRLF;
  if (reply instanceof Status) return '+' + reply.value + CRLF;
  if (reply instanceof RespError) return errorLine(reply.message);
  if (reply instanceof RespMap) {
    // nested in RESP2 (XREAD): [[k, v], …]
    if (reply.nestedInResp2 && proto === 2) return '*' + reply.entries.length + CRLF + writePairs(reply.entries, proto, true);
    const head = proto === 3 ? '%' + reply.entries.length : '*' + reply.entries.length * 2;
    return head + CRLF + writePairs(reply.entries, proto, false);
  }
  if (reply instanceof RespSet) return (proto === 3 ? '~' : '*') + reply.items.length + CRLF + writeAll(reply.items, proto);
  if (reply instanceof RespPush) return (proto === 3 ? '>' : '*') + reply.items.length + CRLF + writeAll(reply.items, proto);
  if (reply instanceof RespDouble) {
    const text = reply.text ?? formatDouble(reply.value);
    return proto === 3 ? ',' + text + CRLF : bulk(text);
  }
  if (reply instanceof RespVerbatim) {
    if (proto === 2) return bulk(reply.text);
    const body = reply.format + ':' + reply.text;
    return '=' + body.length + CRLF + body + CRLF;
  }
  if (reply instanceof RespBool) {
    if (proto === 3) return reply.value ? '#t\r\n' : '#f\r\n';
    return reply.value ? ':1\r\n' : ':0\r\n';
  }
  if (reply instanceof RespPairs) {
    const count = proto === 3 ? reply.pairs.length : reply.pairs.length * 2;
    return '*' + count + CRLF + writePairs(reply.pairs, proto, proto === 3);
  }
  const text = reply.value.toString();
  return proto === 3 ? '(' + text + CRLF : bulk(text);
}

// ============================================================================
// Public API
// ============================================================================

export function encode(reply: Reply, proto: Protocol = 2): Buffer {
  return Buffer.from(write(reply, proto), 'latin1');
}

/** Converts RESP3-typed replies to their RESP2 shape (what Lua scripts see by default). */
export function toResp2(reply: Reply): Reply {
  if (reply instanceof RespMap && reply.nestedInResp2)
    return reply.entries.map(([k, v]) => [toResp2(k), toResp2(v)]);
  if (reply instanceof RespMap)
    return reply.entries.flatMap(([k, v]) => [toResp2(k), toResp2(v)]);
  if (reply instanceof RespSet || reply instanceof RespPush)
    return reply.items.map(toResp2);
  if (reply instanceof RespDouble)
    return reply.text ?? formatDouble(reply.value);
  if (reply instanceof RespVerbatim) return reply.text;
  if (reply instanceof RespBool) return reply.value ? 1 : 0;
  if (reply instanceof RespBigNumber) return reply.value.toString();
  if (reply instanceof RespPairs)
    return reply.pairs.flatMap(([a, b]) => [toResp2(a), toResp2(b)]);
  if (Array.isArray(reply)) return reply.map(toResp2);
  return reply;
}
