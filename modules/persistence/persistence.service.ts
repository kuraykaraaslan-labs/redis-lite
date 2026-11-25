import PersistenceBytesCodec from './persistence.bytes.codec';
import PersistenceListpackCodec from './persistence.listpack.codec';
import PersistenceObjectDecoderCodec from './persistence.object_decoder.codec';
import PersistenceObjectEncoderCodec from './persistence.object_encoder.codec';
import PersistenceRdbIoCodec from './persistence.rdb_io.codec';
import PersistenceAofService from './persistence.aof.service';
import PersistenceDumpService from './persistence.dump.service';
import PersistenceFilesService from './persistence.files.service';
import PersistenceManifestService from './persistence.manifest.service';
import PersistencePropagateService from './persistence.propagate.service';
import PersistenceRdbService from './persistence.rdb.service';

export {
  PersistenceAofService,
  PersistenceDumpService,
  PersistenceFilesService,
  PersistenceManifestService,
  PersistencePropagateService,
  PersistenceRdbService,
};

/**
 * The persistence module's stateless public API: one flat facade over the sub-services (RDB files, DUMP payloads, AOF
 * text, manifest, propagation rules) and the binary codecs they are built from. Other modules import only this class
 * (and the types). The per-server runtime (Persistence, Propagator) is in persistence.core.ts / persistence.propagator.ts.
 */
export default class PersistenceService {
  // Codecs — CRC-64, LZF, listpack / intset / ziplist / zipmap, object bodies
  static readonly DEFAULT_RDB_OPTIONS = PersistenceRdbIoCodec.DEFAULT_OPTIONS;
  static crc64 = PersistenceBytesCodec.crc64.bind(PersistenceBytesCodec);
  static lzfCompress = PersistenceBytesCodec.lzfCompress.bind(PersistenceBytesCodec);
  static lzfDecompress = PersistenceBytesCodec.lzfDecompress.bind(PersistenceBytesCodec);
  static listpackBytes = PersistenceListpackCodec.listpackBytes.bind(PersistenceListpackCodec);
  static listpackEncode = PersistenceListpackCodec.listpackEncode.bind(PersistenceListpackCodec);
  static listpackDecode = PersistenceListpackCodec.listpackDecode.bind(PersistenceListpackCodec);
  static intsetEncode = PersistenceListpackCodec.intsetEncode.bind(PersistenceListpackCodec);
  static intsetDecode = PersistenceListpackCodec.intsetDecode.bind(PersistenceListpackCodec);
  static ziplistDecode = PersistenceListpackCodec.ziplistDecode.bind(PersistenceListpackCodec);
  static zipmapDecode = PersistenceListpackCodec.zipmapDecode.bind(PersistenceListpackCodec);
  static encodeObject = PersistenceObjectEncoderCodec.encodeObject.bind(PersistenceObjectEncoderCodec);
  static decodeObject = PersistenceObjectDecoderCodec.decodeObject.bind(PersistenceObjectDecoderCodec);

  // RDB files
  static defaultRdbAux = PersistenceRdbService.defaultRdbAux.bind(PersistenceRdbService);
  static writeRdb = PersistenceRdbService.writeRdb.bind(PersistenceRdbService);
  static readRdb = PersistenceRdbService.readRdb.bind(PersistenceRdbService);
  static rdbLength = PersistenceRdbService.rdbLength.bind(PersistenceRdbService);

  // DUMP / RESTORE, FUNCTION DUMP / RESTORE
  static dumpPayload = PersistenceDumpService.dumpPayload.bind(PersistenceDumpService);
  static verifyDumpPayload = PersistenceDumpService.verifyDumpPayload.bind(PersistenceDumpService);
  static restorePayloadEx = PersistenceDumpService.restorePayloadEx.bind(PersistenceDumpService);
  static restorePayload = PersistenceDumpService.restorePayload.bind(PersistenceDumpService);
  static functionsDumpPayload = PersistenceDumpService.functionsDumpPayload.bind(PersistenceDumpService);
  static functionsRestorePayload = PersistenceDumpService.functionsRestorePayload.bind(PersistenceDumpService);

  // AOF text
  static encodeAofCommand = PersistenceAofService.encodeAofCommand.bind(PersistenceAofService);
  static parseAofCommand = PersistenceAofService.parseAofCommand.bind(PersistenceAofService);
  static formatG17 = PersistenceAofService.formatG17.bind(PersistenceAofService);
  static snapshotToAof = PersistenceAofService.snapshotToAof.bind(PersistenceAofService);

  // AOF manifest (and the sdssplitargs() it is written in, also used by redis.conf)
  static splitArgs = PersistenceManifestService.splitArgs.bind(PersistenceManifestService);
  static emptyManifest = PersistenceManifestService.emptyManifest.bind(PersistenceManifestService);
  static parseAofManifest = PersistenceManifestService.parseAofManifest.bind(PersistenceManifestService);
  static formatAofManifest = PersistenceManifestService.formatAofManifest.bind(PersistenceManifestService);

  // Files
  static strerror = PersistenceFilesService.strerror.bind(PersistenceFilesService);
  static writeAtomicSync = PersistenceFilesService.writeAtomicSync.bind(PersistenceFilesService);
  static fsyncDir = PersistenceFilesService.fsyncDir.bind(PersistenceFilesService);
  static tryUnlink = PersistenceFilesService.tryUnlink.bind(PersistenceFilesService);

  // Propagation rules
  static isForcedPropagation = PersistencePropagateService.isForcedPropagation.bind(PersistencePropagateService);
  static expiredKeyOp = PersistencePropagateService.expiredKeyOp.bind(PersistencePropagateService);
  static propagateOps = PersistencePropagateService.propagateOps.bind(PersistencePropagateService);
  static propagate = PersistencePropagateService.propagate.bind(PersistencePropagateService);
}
