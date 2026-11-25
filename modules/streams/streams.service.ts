import StreamsAppendService from './streams.append.service';
import StreamsGroupService from './streams.group.service';
import StreamsInfoService from './streams.info.service';
import StreamsPendingService from './streams.pending.service';
import StreamsRangeService from './streams.range.service';
import StreamsReadService from './streams.read.service';

export { StreamsAppendService, StreamsGroupService, StreamsInfoService, StreamsPendingService, StreamsRangeService, StreamsReadService };

/** The streams module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class StreamsService {
  // Append — XADD, XTRIM, XDEL
  static add = StreamsAppendService.add.bind(StreamsAppendService);
  static trim = StreamsAppendService.trim.bind(StreamsAppendService);
  static del = StreamsAppendService.del.bind(StreamsAppendService);

  // Range — stream lookup, XLEN, XRANGE, XREVRANGE
  static read = StreamsRangeService.read.bind(StreamsRangeService);
  static len = StreamsRangeService.len.bind(StreamsRangeService);
  static range = StreamsRangeService.range.bind(StreamsRangeService);

  // Read — XREAD, XREADGROUP
  static xread = StreamsReadService.read.bind(StreamsReadService);
  static xreadGroup = StreamsReadService.readGroup.bind(StreamsReadService);

  // Groups — XGROUP
  static group = StreamsGroupService.group.bind(StreamsGroupService);

  // Pending — XACK, XPENDING, XCLAIM, XAUTOCLAIM
  static findGroup = StreamsPendingService.findGroup.bind(StreamsPendingService);
  static ack = StreamsPendingService.ack.bind(StreamsPendingService);
  static pending = StreamsPendingService.pending.bind(StreamsPendingService);
  static claim = StreamsPendingService.claim.bind(StreamsPendingService);
  static autoClaim = StreamsPendingService.autoClaim.bind(StreamsPendingService);

  // Info — XINFO, XSETID
  static infoHelp = StreamsInfoService.infoHelp.bind(StreamsInfoService);
  static infoRead = StreamsInfoService.infoRead.bind(StreamsInfoService);
  static infoStream = StreamsInfoService.infoStream.bind(StreamsInfoService);
  static infoGroups = StreamsInfoService.infoGroups.bind(StreamsInfoService);
  static infoConsumers = StreamsInfoService.infoConsumers.bind(StreamsInfoService);
  static setId = StreamsInfoService.setId.bind(StreamsInfoService);
}
