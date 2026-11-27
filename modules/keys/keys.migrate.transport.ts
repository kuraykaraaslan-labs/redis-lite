// Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';

import { MIGRATE_WORKER_SOURCE } from './keys.migrate.worker';

/** What MIGRATE asks the network thread to do. Strings are binary (latin1). */
export interface MigrateExchange {
  host: string;
  port: string;
  /** Per connect / per reply budget, ms. */
  timeout: number;
  /** The target database (selected when the cached connection is not on it). */
  db: string;
  /** `AUTH [username] password`, sent first, or null. */
  auth: string[] | null;
  /** One RESTORE command per key. */
  restores: string[][];
}

/** The outcome: the reply lines (AUTH, SELECT when sent, then one per RESTORE), or the stage that failed. */
export type MigrateOutcome = { kind: 'ok'; replies: string[] } | { kind: 'io'; stage: 'connect' | 'write' | 'read' };

/**
 * The MIGRATE network thread, seen from the server: one lazily started worker (shared by the servers of the process,
 * like a connection cache per target) and a synchronous call. `exchange()` blocks the calling thread until the worker
 * answers, which is what Redis does: MIGRATE is atomic and the source server serves nothing else meanwhile.
 *
 * A stateful component (the worker and its cached connections), hence an instance with a static accessor.
 */
export class MigrateTransport {
  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  private static instance: MigrateTransport | null = null;

  private readonly cell = new Int32Array(new SharedArrayBuffer(4));
  private nextId = 1;
  private readonly port: MessagePort;
  private readonly worker: Worker;

  private constructor() {
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(MIGRATE_WORKER_SOURCE, { eval: true, workerData: { cell: this.cell, port: port2 }, transferList: [port2] });
    this.worker.unref();
    this.port.unref();
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  static get(): MigrateTransport {
    MigrateTransport.instance ??= new MigrateTransport();
    return MigrateTransport.instance;
  }

  /**
   * Runs one exchange and waits for it. A worker that does not answer in time counts as a read timeout; its late
   * answer is recognised by its id and dropped.
   */
  exchange(request: MigrateExchange): MigrateOutcome {
    const id = this.nextId++;
    const timeout = Math.min(request.timeout, 2 ** 31 - 1);
    Atomics.store(this.cell, 0, 0);
    this.port.postMessage({ ...request, id, timeout });
    // connect + one read per command, each within the timeout, and a retry: a generous upper bound
    const deadline = Date.now() + Math.min(timeout * (request.restores.length + 4) * 2 + 5_000, 2 ** 31 - 1);
    for (;;) {
      Atomics.wait(this.cell, 0, 0, Math.max(0, deadline - Date.now()));
      Atomics.store(this.cell, 0, 0);
      for (let m = receiveMessageOnPort(this.port); m; m = receiveMessageOnPort(this.port)) {
        const answer = m.message as { id: number; outcome: MigrateOutcome };
        if (answer.id === id) return answer.outcome;
      }
      if (Date.now() >= deadline) return { kind: 'io', stage: 'read' };
    }
  }
}
