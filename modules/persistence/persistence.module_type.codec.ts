/**
 * Module data types in RDB files and DUMP payloads (RDB type 7, MODULE_2): the 64-bit module type id (the 9-character
 * type name in a 64-symbol charset, 6 bits per character, then a 10-bit encoding version) followed by the value as a
 * list of typed module opcodes (UINT, SINT, DOUBLE, STRING…) closed by EOF, as the RDB format frames module values.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * The only module type is the time series (`TSDB-TYPE`). Its body is redis-lite's own layout (settings, labels, rules,
 * chunks of samples): the framing follows the RDB format, but a file written by RedisTimeSeries cannot be read here and
 * vice versa. Any other module type id is refused as unsupported.
 */
import { TimeSeries, TSDB_TYPE_NAME } from '@/modules/timeseries/timeseries.structure';
import { AggregatorEnum, DuplicatePolicyEnum } from '@/modules/timeseries/timeseries.enums';
import type { RedisValue } from '@/modules/database/database.types';

import PersistenceBytesCodec from './persistence.bytes.codec';
import type { RdbReader, RdbWriter } from './persistence.bytes.codec';
import PersistenceMessages from './persistence.messages';
import PersistenceRdbIoCodec from './persistence.rdb_io.codec';

export default class PersistenceModuleTypeCodec {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Module type names are 9 characters of this set; each character is its 6-bit index. */
  private static readonly CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /** RDB module opcodes. */
  private static readonly OP = { EOF: 0, SINT: 1, UINT: 2, FLOAT: 3, DOUBLE: 4, STRING: 5 } as const;

  /** redis-lite's encoding version of its time series payload. */
  private static readonly TS_ENCODING_VERSION = 1;

  // ──────────────────────────────────────────────
  // Private Helpers: opcodes
  // ──────────────────────────────────────────────

  private static uint(w: RdbWriter, n: number): void {
    PersistenceRdbIoCodec.writeLen(w, PersistenceModuleTypeCodec.OP.UINT);
    PersistenceRdbIoCodec.writeLen(w, BigInt(n));
  }

  private static sint(w: RdbWriter, n: number): void {
    PersistenceRdbIoCodec.writeLen(w, PersistenceModuleTypeCodec.OP.SINT);
    PersistenceRdbIoCodec.writeLen(w, BigInt.asUintN(64, BigInt(n)));
  }

  private static double(w: RdbWriter, n: number): void {
    PersistenceRdbIoCodec.writeLen(w, PersistenceModuleTypeCodec.OP.DOUBLE);
    w.doubleLe(n);
  }

  private static string(w: RdbWriter, s: string): void {
    PersistenceRdbIoCodec.writeLen(w, PersistenceModuleTypeCodec.OP.STRING);
    PersistenceRdbIoCodec.writeStr(w, s, false);
  }

  private static expect(r: RdbReader, op: number): void {
    if (PersistenceRdbIoCodec.readLen(r) !== op) throw PersistenceBytesCodec.badFormat();
  }

  private static readUint(r: RdbReader): number {
    PersistenceModuleTypeCodec.expect(r, PersistenceModuleTypeCodec.OP.UINT);
    return Number(PersistenceRdbIoCodec.readLenBig(r));
  }

  private static readSint(r: RdbReader): number {
    PersistenceModuleTypeCodec.expect(r, PersistenceModuleTypeCodec.OP.SINT);
    return Number(BigInt.asIntN(64, PersistenceRdbIoCodec.readLenBig(r)));
  }

  private static readDouble(r: RdbReader): number {
    PersistenceModuleTypeCodec.expect(r, PersistenceModuleTypeCodec.OP.DOUBLE);
    return r.doubleLe();
  }

  private static readString(r: RdbReader): string {
    PersistenceModuleTypeCodec.expect(r, PersistenceModuleTypeCodec.OP.STRING);
    return PersistenceRdbIoCodec.readStr(r);
  }

  // ──────────────────────────────────────────────
  // Private Helpers: type ids
  // ──────────────────────────────────────────────

  private static moduleId(name: string, encver: number): bigint {
    let id = 0n;
    for (const ch of name) id = (id << 6n) | BigInt(PersistenceModuleTypeCodec.CHARSET.indexOf(ch));
    return (id << 10n) | BigInt(encver);
  }

  private static moduleName(id: bigint): { name: string; encver: number } {
    let name = '';
    for (let i = 8; i >= 0; i--) name += PersistenceModuleTypeCodec.CHARSET[Number((id >> BigInt(10 + i * 6)) & 63n)];
    return { name, encver: Number(id & 1023n) };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** Writes a time series as a module value (the type byte is the caller's: MODULE_2). */
  static encodeTimeseries(w: RdbWriter, series: TimeSeries): void {
    const C = PersistenceModuleTypeCodec;
    const s = series.settings;
    PersistenceRdbIoCodec.writeLen(w, C.moduleId(TSDB_TYPE_NAME, C.TS_ENCODING_VERSION));
    C.uint(w, s.retention);
    C.uint(w, s.chunkSize);
    C.uint(w, s.encoding === 'compressed' ? 1 : 0);
    C.uint(w, s.duplicatePolicy === null ? 0 : DuplicatePolicyEnum.options.indexOf(s.duplicatePolicy) + 1);
    C.uint(w, s.ignoreMaxTimeDiff);
    C.double(w, s.ignoreMaxValDiff);
    C.uint(w, series.srcKey === null ? 0 : 1);
    if (series.srcKey !== null) C.string(w, series.srcKey);
    C.uint(w, series.labels.size);
    for (const [label, value] of series.labels) {
      C.string(w, label);
      C.string(w, value);
    }
    C.uint(w, series.rules.length);
    for (const rule of series.rules) {
      C.string(w, rule.destKey);
      C.uint(w, AggregatorEnum.options.indexOf(rule.aggregator));
      C.uint(w, rule.bucketDuration);
      C.sint(w, rule.alignTimestamp);
      C.sint(w, rule.since ?? -1);
    }
    C.uint(w, series.chunks.length);
    for (const chunk of series.chunks) {
      C.uint(w, chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        C.uint(w, chunk.timestamps[i]);
        C.double(w, chunk.values[i]);
      }
    }
    PersistenceRdbIoCodec.writeLen(w, C.OP.EOF);
  }

  /** Reads a module value (after the MODULE_2 type byte); only redis-lite's time series payload is understood. */
  static decodeModule(r: RdbReader): RedisValue {
    const C = PersistenceModuleTypeCodec;
    const { name, encver } = C.moduleName(PersistenceRdbIoCodec.readLenBig(r));
    if (name !== TSDB_TYPE_NAME || encver !== C.TS_ENCODING_VERSION) throw new Error(PersistenceMessages.MODULE_TYPES_UNSUPPORTED);
    const retention = C.readUint(r);
    const chunkSize = C.readUint(r);
    const encoding = C.readUint(r) ? 'compressed' : 'uncompressed';
    const policy = C.readUint(r);
    const ignoreMaxTimeDiff = C.readUint(r);
    const ignoreMaxValDiff = C.readDouble(r);
    const duplicatePolicy = policy === 0 ? null : DuplicatePolicyEnum.options[policy - 1];
    if (duplicatePolicy === undefined) throw PersistenceBytesCodec.badFormat();
    const series = new TimeSeries({ retention, chunkSize, encoding, duplicatePolicy, ignoreMaxTimeDiff, ignoreMaxValDiff });
    if (C.readUint(r)) series.srcKey = C.readString(r);
    for (let n = C.readUint(r); n > 0; n--) series.labels.set(C.readString(r), C.readString(r));
    for (let n = C.readUint(r); n > 0; n--) {
      const destKey = C.readString(r);
      const aggregator = AggregatorEnum.options[C.readUint(r)];
      if (aggregator === undefined) throw PersistenceBytesCodec.badFormat();
      const bucketDuration = C.readUint(r);
      const alignTimestamp = C.readSint(r);
      const since = C.readSint(r);
      series.rules.push({ destKey, aggregator, bucketDuration, alignTimestamp, since: since < 0 ? null : since });
    }
    for (let n = C.readUint(r); n > 0; n--) {
      const timestamps: number[] = [];
      const values: number[] = [];
      for (let k = C.readUint(r); k > 0; k--) {
        timestamps.push(C.readUint(r));
        values.push(C.readDouble(r));
      }
      series.loadChunk(timestamps, values);
    }
    C.expect(r, C.OP.EOF);
    return { type: 'timeseries', value: series };
  }
}
