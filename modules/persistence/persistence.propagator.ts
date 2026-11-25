import type { Reply } from '@/libs/resp';

import type { PropagationTarget } from './persistence.enums';
import PersistenceService from './persistence.service';
import type { PropagatedOp, PropagationSink, PropagatorOptions, RecordHints } from './persistence.types';

/**
 * Redis's also_propagate / execution-unit model (server.also_propagate + propagatePendingCommands): a stateful
 * component, one per server.
 *
 *   propagator.enter(name)            // every execute(), nested ones included
 *   … run the command …
 *   propagator.record(db, argv, reply, dirtyDelta)
 *   propagator.exit()                 // the outermost exit flushes the unit to the sinks
 *
 * Scripts: EVAL / FCALL record nothing themselves; each redis.call goes through execute(), so its write is recorded
 * into the script's unit ("effects replication"). EXEC likewise. A unit with more than one op is wrapped in
 * MULTI … EXEC; a single op is propagated bare ("the single command is atomic"). The SELECT for an op is emitted by the
 * sink, inside the MULTI. What one command turns into is PersistenceService.propagateOps.
 */
export class Propagator {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** Commands flagged CMD_TOUCHES_ARBITRARY_KEYS: their lazy-expire DELs are not wrapped in MULTI/EXEC. */
  private static readonly TOUCHES_ARBITRARY_KEYS = new Set(['keys', 'scan', 'randomkey']);

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  private depth = 0;
  private pending: PropagatedOp[] = [];
  private noTransaction = false;
  private paused = 0;
  private readonly sinks: PropagationSink[] = [];
  /** Per sink: whether it currently takes ops (an AOF sink while appendonly is off does not). Undefined = always. */
  private readonly sinkActive: Array<(() => boolean) | undefined> = [];

  constructor(private readonly options: PropagatorOptions) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private lazy(name: string): boolean {
    return this.options.config.get(name) === 'yes';
  }

  /**
   * Whether anything would receive the ops of a command recorded now. When nothing would (no AOF, no replica), recording
   * is skipped entirely: computing a command's propagated form costs a rewrite and allocations on every write.
   */
  private get wanted(): boolean {
    const active = this.sinkActive;
    for (let i = 0; i < active.length; i++) {
      const isActive = active[i];
      if (!isActive || isActive()) return true;
    }
    return false;
  }

  private push(ops: PropagatedOp[]): void {
    if (!ops.length) return;
    this.pending.push(...ops);
    if (this.depth === 0) this.flush();
  }

  private flush(): void {
    const ops = this.pending;
    this.pending = [];
    if (!ops.length) return;
    const wrapped = ops.length > 1 && !this.noTransaction ? [this.op(-1, ['MULTI']), ...ops, this.op(-1, ['EXEC'])] : ops;
    for (const sink of [...this.sinks]) sink(wrapped);
  }

  private op(db: number, argv: string[], target: PropagationTarget = 'all'): PropagatedOp {
    return { db, argv, target };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * Adds a sink (AOF, replication). `active`: whether the sink takes ops right now; while no sink is active nothing is
   * recorded (a sink that ignores ops in some state, like the AOF while appendonly is off, passes it). Returns a function
   * that removes the sink.
   */
  addSink(sink: PropagationSink, active?: () => boolean): () => void {
    this.sinks.push(sink);
    this.sinkActive.push(active);
    return () => {
      const i = this.sinks.indexOf(sink);
      if (i < 0) return;
      this.sinks.splice(i, 1);
      this.sinkActive.splice(i, 1);
    };
  }

  /** Stops propagation (while loading the RDB / AOF). Nestable. */
  pause(): void {
    this.paused++;
  }

  resume(): void {
    if (this.paused > 0) this.paused--;
  }

  get isPaused(): boolean {
    return this.paused > 0;
  }

  /** True inside an execution unit. */
  get inUnit(): boolean {
    return this.depth > 0;
  }

  /** Starts (or nests into) an execution unit. `commandName`: the top-level command (KEYS/SCAN/RANDOMKEY never wrap). */
  enter(commandName = ''): void {
    if (this.depth === 0) {
      this.pending = [];
      this.noTransaction = Propagator.TOUCHES_ARBITRARY_KEYS.has(commandName.toLowerCase());
    }
    this.depth++;
  }

  /** Ends a unit level; the outermost one propagates what was collected. */
  exit(): void {
    if (this.depth === 0) return;
    this.depth--;
    if (this.depth === 0) this.flush();
  }

  /**
   * Records an executed command. `dirty`: how much the dirty counter moved while it ran (Redis propagates a command
   * only when it did, or when propagation is forced). Returns the ops added.
   */
  record(dbIndex: number, argv: readonly string[], reply: Reply, dirty: number, hints: RecordHints = {}): PropagatedOp[] {
    if (this.paused || !this.wanted) return [];
    if (dirty <= 0 && !PersistenceService.isForcedPropagation(argv)) return [];
    const database = this.options.databases[dbIndex];
    if (!database) return [];
    const ops = PersistenceService.propagateOps(argv, reply, {
      db: dbIndex,
      database,
      lazyfreeLazyExpire: this.lazy('lazyfree-lazy-expire'),
      lazyfreeLazyServerDel: this.lazy('lazyfree-lazy-server-del'),
      createdConsumerKeys: hints.createdConsumerKeys,
    });
    this.push(ops);
    return ops;
  }

  /** Redis alsoPropagate(): adds an op to the current unit (or propagates it at once outside a unit). */
  also(dbIndex: number, argv: string[], target: PropagationTarget = 'all'): void {
    if (this.paused || !this.wanted) return;
    this.push([this.op(dbIndex, argv, target)]);
  }

  /**
   * A key expired (lazily on access, or by the active expire cycle): DEL / UNLINK per lazyfree-lazy-expire. Inside a
   * unit it joins the unit (Redis 7: deleteExpiredKeyAndPropagate → alsoPropagate, flushed at the end of the execution
   * unit), so a write on an expired key propagates as MULTI, DEL, <write>, EXEC. UNCERTAIN for 8.x.
   */
  expired(dbIndex: number, key: string): void {
    if (this.paused || !this.wanted) return;
    this.push([PersistenceService.expiredKeyOp(dbIndex, key, this.lazy('lazyfree-lazy-expire'))]);
  }
}

export default Propagator;
