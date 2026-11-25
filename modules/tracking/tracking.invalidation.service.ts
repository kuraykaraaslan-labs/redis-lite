import type { Reply } from '@/libs/resp';
import { NULL_ARRAY, RespPush } from '@/libs/resp';

import type { Client } from '@/modules/server/server.service';

import TrackingMessages from './tracking.messages';
import type { TrackingState, TrackingStats } from './tracking.types';

/**
 * Remembering reads and sending invalidations: the default-mode key table, BCAST prefixes, NOLOOP, REDIRECT,
 * FLUSHALL / FLUSHDB, tracking-table-max-keys, and deferring the running client's own invalidations after its reply.
 */
export default class TrackingInvalidationService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static collectBcast(state: TrackingState, key: string, by: Client | null): void {
    let any = false;
    for (const [prefix, entry] of state.prefixes) {
      if (!key.startsWith(prefix)) continue;
      let modifiers = entry.pending.get(key);
      if (!modifiers) entry.pending.set(key, (modifiers = new Set()));
      modifiers.add(by ? by.id : 0);
      any = true;
    }
    if (any && !state.bcastScheduled) {
      state.bcastScheduled = true;
      setImmediate(() => TrackingInvalidationService.flushBcast(state));
    }
  }

  /** Delivers an invalidation (null = everything) to a tracking client or its redirect target. */
  private static deliver(state: TrackingState, client: Client, keys: string[] | null): void {
    let target = client;
    if (client.trackingRedirect) {
      const t = state.host.clientById(client.trackingRedirect);
      if (!t) {
        client.trackingRedirectBroken = true;
        if (client.resp === 3) TrackingInvalidationService.send(client, new RespPush([TrackingMessages.PUSH_REDIR_BROKEN, client.trackingRedirect]));
        return;
      }
      target = t;
    }
    if (target === state.current) {
      let queue = state.deferred.get(target);
      if (!queue) state.deferred.set(target, (queue = []));
      queue.push(keys);
      return;
    }
    TrackingInvalidationService.write(target, keys);
  }

  private static write(target: Client, keys: string[] | null): void {
    const M = TrackingMessages;
    if (target.resp === 3) TrackingInvalidationService.send(target, new RespPush([M.PUSH_INVALIDATE, keys ?? null]));
    else if (target.channels.has(M.INVALIDATE_CHANNEL)) {
      TrackingInvalidationService.send(target, new RespPush([M.PUSH_MESSAGE, M.INVALIDATE_CHANNEL, keys ?? NULL_ARRAY]));
    }
  }

  private static send(target: Client, push: Reply): void {
    target.write(push);
  }

  // ──────────────────────────────────────────────
  // Public Methods: remembering reads
  // ──────────────────────────────────────────────

  /** A read-only command of `client` accessed `keys`. */
  static remember(state: TrackingState, client: Client, keys: readonly string[]): void {
    if (!client.tracking || client.trackingBcast || !keys.length) return;
    if (client.trackingOptin && client.trackingCaching !== 'yes') return;
    if (client.trackingOptout && client.trackingCaching === 'no') return;
    for (const key of keys) {
      let ids = state.table.get(key);
      if (!ids) state.table.set(key, (ids = new Set()));
      ids.add(client.id);
    }
  }

  /** tracking-table-max-keys: drops (and invalidates) the oldest keys while the table is too large. */
  static enforceLimit(state: TrackingState): void {
    const max = state.host.config.num('tracking-table-max-keys');
    if (max <= 0) return;
    while (state.table.size > max) {
      const key = state.table.keys().next().value as string;
      TrackingInvalidationService.invalidate(state, key, null);
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods: invalidation
  // ──────────────────────────────────────────────

  /** A key was modified (by `by`, null for the server itself: expiry, eviction). */
  static invalidate(state: TrackingState, key: string, by: Client | null): void {
    const ids = state.table.get(key);
    if (ids) {
      state.table.delete(key);
      for (const id of ids) {
        const c = state.host.clientById(id);
        if (!c || !c.tracking || c.trackingBcast) continue;
        if (c.trackingNoloop && c === by) continue;
        TrackingInvalidationService.deliver(state, c, [key]);
      }
    }
    if (state.prefixes.size) TrackingInvalidationService.collectBcast(state, key, by);
  }

  /** Sends the collected BCAST invalidations: one message per prefix and client. */
  static flushBcast(state: TrackingState): void {
    state.bcastScheduled = false;
    for (const entry of state.prefixes.values()) {
      if (!entry.pending.size) continue;
      const pending = [...entry.pending];
      entry.pending.clear();
      for (const c of entry.clients) {
        const keys = c.trackingNoloop ? pending.filter(([, by]) => !(by.size === 1 && by.has(c.id))).map(([k]) => k) : pending.map(([k]) => k);
        if (keys.length) TrackingInvalidationService.deliver(state, c, keys);
      }
    }
  }

  /** FLUSHALL / FLUSHDB: a null invalidation to every tracking client; the table is emptied. */
  static flushed(state: TrackingState): void {
    state.table.clear();
    for (const entry of state.prefixes.values()) entry.pending.clear();
    for (const c of state.host.clients) if (c.tracking) TrackingInvalidationService.deliver(state, c, null);
  }

  /** Sends what was deferred for `client` (call after its reply was written). */
  static flushDeferred(state: TrackingState, client: Client): void {
    const queue = state.deferred.get(client);
    if (!queue) return;
    state.deferred.delete(client);
    for (const keys of queue) TrackingInvalidationService.write(client, keys);
  }

  /** INFO stats tracking_total_keys / items / prefixes. */
  static stats(state: TrackingState): TrackingStats {
    let items = 0;
    for (const ids of state.table.values()) items += ids.size;
    return { keys: state.table.size, items, prefixes: state.prefixes.size };
  }
}
