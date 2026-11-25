import TransactionsExecService from './transactions.exec.service';
import TransactionsQueueService from './transactions.queue.service';
import TransactionsWatchService from './transactions.watch.service';

export { TransactionsExecService, TransactionsQueueService, TransactionsWatchService };

/** The transactions module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class TransactionsService {
  // Queue — MULTI, DISCARD
  static multi = TransactionsQueueService.multi.bind(TransactionsQueueService);
  static discard = TransactionsQueueService.discard.bind(TransactionsQueueService);

  // Watch — WATCH, UNWATCH
  static watch = TransactionsWatchService.watch.bind(TransactionsWatchService);
  static unwatch = TransactionsWatchService.unwatch.bind(TransactionsWatchService);

  // Exec — EXEC
  static exec = TransactionsExecService.exec.bind(TransactionsExecService);
}
