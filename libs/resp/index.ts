/**
 * RESP2 / RESP3 wire protocol: reply values (`reply.ts`), the reply encoder (`encoder.ts`) and the request parser
 * (`parser.ts`).
 *
 * Every Redis string is kept as a "binary string": a JS string where each char is one byte (latin1). That keeps keys and
 * values byte-exact (msgpack payloads, UTF-8 text, anything) while still letting us use them as Map keys.
 */
export {
  formatDouble,
  NULL_ARRAY,
  OK,
  PONG,
  QUEUED,
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
export type { Protocol, Reply } from './reply';
export { encode, toResp2 } from './encoder';
export { RespParser } from './parser';
export type { ParseResult, RespParserOptions } from './parser';
