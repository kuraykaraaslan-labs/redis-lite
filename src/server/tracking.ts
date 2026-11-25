/**
 * Server-assisted client-side caching (CLIENT TRACKING), following the redis.io client-side caching docs and the
 * CLIENT TRACKING / CACHING / GETREDIR / TRACKINGINFO command pages.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * - Default mode: the keys a tracking client reads (read-only commands) are remembered in one invalidation table
 *   (key name → client ids; the database number is not part of it, as documented). When such a key is modified,
 *   expires or is evicted, every client remembered for it gets one invalidation message and the key leaves the table
 *   (the client must read it again to be tracked again).
 * - OPTIN / OPTOUT: reads are tracked only after CLIENT CACHING YES / unless CLIENT CACHING NO, for the next command
 *   (a whole MULTI/EXEC or script counts as one).
 * - BCAST: nothing is remembered; every modified key matching one of the client's prefixes ('' = all keys) is
 *   announced. Keys are collected and sent in one message per prefix after the current event-loop turn.
 * - NOLOOP: no invalidation for keys the client modified itself.
 * - REDIRECT: messages go to another connection. A RESP3 target gets the `invalidate` push; a RESP2 target gets a
 *   Pub/Sub message on `__redis__:invalidate` when it is subscribed to that channel. When the target is gone, a RESP3
 *   tracking client is told with a `tracking-redir-broken` push.
 * - FLUSHALL / FLUSHDB: every tracking client gets an invalidation with a null key list, and the table is emptied.
 * - tracking-table-max-keys: when the table grows larger, keys are dropped from it (oldest first) and invalidated as if
 *   they had been modified.
 * - Invalidations for the client running the current command are delivered after that command's reply.
 */
import { CommandError } from '../errors';
import { RespMessages } from '../messages';
import type { Reply } from '../resp';
import { NULL_ARRAY, RespPush } from '../resp';
import type { Client } from './client';
import type { ServerConfig } from './config';

export const INVALIDATE_CHANNEL = '__redis__:invalidate';

export interface TrackingHost {
  readonly config: ServerConfig;
  clientById(id: number): Client | undefined;
  /** Every connected client. */
  readonly clients: Iterable<Client>;
}

export interface TrackingOptions {
  on: boolean;
  redirect: number;
  bcast: boolean;
  optin: boolean;
  optout: boolean;
  noloop: boolean;
  prefixes: string[];
}

/** Parses `CLIENT TRACKING ON|OFF [REDIRECT id] [PREFIX p]... [BCAST] [OPTIN] [OPTOUT] [NOLOOP]` (args after TRACKING). */
export function parseTrackingArgs(args: string[]): TrackingOptions {
  const mode = args[0].toLowerCase();
  if (mode !== 'on' && mode !== 'off') throw new CommandError(RespMessages.SYNTAX);
  const o: TrackingOptions = { on: mode === 'on', redirect: 0, bcast: false, optin: false, optout: false, noloop: false, prefixes: [] };
  for (let i = 1; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    const more = i + 1 < args.length;
    if (opt === 'redirect' && more) {
      const raw = args[++i];
      if (!/^-?\d+$/.test(raw)) throw new CommandError(RespMessages.NOT_INTEGER);
      o.redirect = Number(raw);
    } else if (opt === 'prefix' && more) o.prefixes.push(args[++i]);
    else if (opt === 'bcast') o.bcast = true;
    else if (opt === 'optin') o.optin = true;
    else if (opt === 'optout') o.optout = true;
    else if (opt === 'noloop') o.noloop = true;
    else throw new CommandError(RespMessages.SYNTAX);
  }
  return o;
}

export class Tracking {
  /** Default mode: key → ids of the clients that read it. */
  private readonly table = new Map<string, Set<number>>();
  /** BCAST: prefix → subscribed clients and the keys modified since the last delivery (key → ids of modifiers). */
  private readonly prefixes = new Map<string, { clients: Set<Client>; pending: Map<string, Set<number>> }>();
  private bcastScheduled = false;
  /** Invalidations for the client whose command is running, sent after its reply. */
  private readonly deferred = new Map<Client, Array<string[] | null>>();
  /** The client running the current top-level command (or being served after blocking). */
  current: Client | null = null;

  constructor(private readonly host: TrackingHost) {}

  // ---- CLIENT TRACKING -------------------------------------------------------------------------------------------

  /** CLIENT TRACKING: validates like Redis, then enables or disables. */
  configure(client: Client, o: TrackingOptions): void {
    if (!o.on) {
      this.disable(client);
      return;
    }
    if (o.redirect !== 0 && !this.host.clientById(o.redirect)) {
      throw new CommandError('ERR The client ID you want redirect to does not exist');
    }
    if (o.prefixes.length && !o.bcast) throw new CommandError('ERR PREFIX option requires BCAST mode to be enabled');
    if (client.tracking) {
      if (client.trackingBcast !== o.bcast) {
        throw new CommandError(
          "ERR You can't switch BCAST mode on/off before disabling tracking for this client, and then re-enabling it with a different mode.",
        );
      }
    }
    if (o.optin && o.optout) throw new CommandError("ERR You can't use both OPTIN and OPTOUT");
    if (o.bcast && (o.optin || o.optout)) throw new CommandError('ERR OPTIN and OPTOUT are not compatible with BCAST');
    if (client.tracking && ((o.optin && client.trackingOptout) || (o.optout && client.trackingOptin))) {
      throw new CommandError(
        "ERR You can't switch OPTIN/OPTOUT mode before disabling tracking for this client, and then re-enabling it with a different mode.",
      );
    }
    if (o.bcast) this.checkPrefixes(client, o.prefixes);

    client.tracking = true;
    client.trackingRedirect = o.redirect;
    client.trackingRedirectBroken = false;
    client.trackingBcast = o.bcast;
    client.trackingOptin = o.optin;
    client.trackingOptout = o.optout;
    client.trackingNoloop = o.noloop;
    client.trackingCaching = null;
    if (o.bcast) {
      const wanted = o.prefixes.length ? o.prefixes : [''];
      for (const p of wanted) {
        if (client.trackingPrefixes.has(p)) continue;
        client.trackingPrefixes.add(p);
        let entry = this.prefixes.get(p);
        if (!entry) this.prefixes.set(p, (entry = { clients: new Set(), pending: new Map() }));
        entry.clients.add(client);
      }
    }
  }

  /** Prefixes of one client must not overlap (one being a prefix of another). */
  private checkPrefixes(client: Client, added: string[]): void {
    const overlaps = (a: string, b: string): boolean => a !== b && (a.startsWith(b) || b.startsWith(a));
    for (let i = 0; i < added.length; i++) {
      const p = added[i];
      for (const existing of client.trackingPrefixes) {
        if (overlaps(p, existing)) {
          throw new CommandError(`ERR Prefix '${p}' overlaps with an existing prefix '${existing}'. Prefixes for a single client must not overlap.`);
        }
      }
      for (let j = 0; j < i; j++) {
        if (overlaps(p, added[j])) {
          throw new CommandError(`ERR Prefix '${p}' overlaps with an existing prefix '${added[j]}'. Prefixes for a single client must not overlap.`);
        }
      }
    }
  }

  /** CLIENT TRACKING OFF, RESET, disconnection. Remembered keys stay in the table and are skipped lazily. */
  disable(client: Client): void {
    for (const p of client.trackingPrefixes) {
      const entry = this.prefixes.get(p);
      if (!entry) continue;
      entry.clients.delete(client);
      if (!entry.clients.size) this.prefixes.delete(p);
    }
    client.trackingPrefixes.clear();
    client.tracking = false;
    client.trackingRedirect = 0;
    client.trackingRedirectBroken = false;
    client.trackingBcast = false;
    client.trackingOptin = false;
    client.trackingOptout = false;
    client.trackingNoloop = false;
    client.trackingCaching = null;
    this.deferred.delete(client);
  }

  /** CLIENT CACHING YES|NO. */
  caching(client: Client, value: string): void {
    const v = value.toLowerCase();
    if (v !== 'yes' && v !== 'no') throw new CommandError(RespMessages.SYNTAX);
    if (!client.tracking || !(client.trackingOptin || client.trackingOptout)) {
      throw new CommandError('ERR CLIENT CACHING can be called only when the client is in tracking mode with OPTIN or OPTOUT mode enabled');
    }
    if (v === 'yes' && !client.trackingOptin) throw new CommandError('ERR CLIENT CACHING YES is only valid when tracking is enabled in OPTIN mode.');
    if (v === 'no' && !client.trackingOptout) throw new CommandError('ERR CLIENT CACHING NO is only valid when tracking is enabled in OPTOUT mode.');
    client.trackingCaching = v;
  }

  /** CLIENT TRACKINGINFO. */
  info(client: Client): { flags: string[]; redirect: number; prefixes: string[] } {
    if (!client.tracking) return { flags: ['off'], redirect: -1, prefixes: [] };
    const flags = ['on'];
    if (client.trackingBcast) flags.push('bcast');
    if (client.trackingOptin) flags.push('optin');
    if (client.trackingOptout) flags.push('optout');
    if (client.trackingCaching === 'yes') flags.push('caching-yes');
    if (client.trackingCaching === 'no') flags.push('caching-no');
    if (client.trackingNoloop) flags.push('noloop');
    if (client.trackingRedirectBroken) flags.push('broken_redirect');
    return { flags, redirect: client.trackingRedirect, prefixes: [...client.trackingPrefixes] };
  }

  // ---- remembering reads -----------------------------------------------------------------------------------------

  /** A read-only command of `client` accessed `keys`. */
  remember(client: Client, keys: readonly string[]): void {
    if (!client.tracking || client.trackingBcast || !keys.length) return;
    if (client.trackingOptin && client.trackingCaching !== 'yes') return;
    if (client.trackingOptout && client.trackingCaching === 'no') return;
    for (const key of keys) {
      let ids = this.table.get(key);
      if (!ids) this.table.set(key, (ids = new Set()));
      ids.add(client.id);
    }
  }

  /** tracking-table-max-keys: drops (and invalidates) the oldest keys while the table is too large. */
  enforceLimit(): void {
    const max = this.host.config.num('tracking-table-max-keys');
    if (max <= 0) return;
    while (this.table.size > max) {
      const key = this.table.keys().next().value as string;
      this.invalidate(key, null);
    }
  }

  // ---- invalidation ----------------------------------------------------------------------------------------------

  /** A key was modified (by `by`, null for the server itself: expiry, eviction). */
  invalidate(key: string, by: Client | null): void {
    const ids = this.table.get(key);
    if (ids) {
      this.table.delete(key);
      for (const id of ids) {
        const c = this.host.clientById(id);
        if (!c || !c.tracking || c.trackingBcast) continue;
        if (c.trackingNoloop && c === by) continue;
        this.deliver(c, [key]);
      }
    }
    if (this.prefixes.size) this.collectBcast(key, by);
  }

  private collectBcast(key: string, by: Client | null): void {
    let any = false;
    for (const [prefix, entry] of this.prefixes) {
      if (!key.startsWith(prefix)) continue;
      let modifiers = entry.pending.get(key);
      if (!modifiers) entry.pending.set(key, (modifiers = new Set()));
      modifiers.add(by ? by.id : 0);
      any = true;
    }
    if (any && !this.bcastScheduled) {
      this.bcastScheduled = true;
      setImmediate(() => this.flushBcast());
    }
  }

  /** Sends the collected BCAST invalidations: one message per prefix and client. */
  flushBcast(): void {
    this.bcastScheduled = false;
    for (const entry of this.prefixes.values()) {
      if (!entry.pending.size) continue;
      const pending = [...entry.pending];
      entry.pending.clear();
      for (const c of entry.clients) {
        const keys = c.trackingNoloop ? pending.filter(([, by]) => !(by.size === 1 && by.has(c.id))).map(([k]) => k) : pending.map(([k]) => k);
        if (keys.length) this.deliver(c, keys);
      }
    }
  }

  /** FLUSHALL / FLUSHDB: a null invalidation to every tracking client; the table is emptied. */
  flushed(): void {
    this.table.clear();
    for (const entry of this.prefixes.values()) entry.pending.clear();
    for (const c of this.host.clients) if (c.tracking) this.deliver(c, null);
  }

  /** Delivers an invalidation (null = everything) to a tracking client or its redirect target. */
  private deliver(client: Client, keys: string[] | null): void {
    let target = client;
    if (client.trackingRedirect) {
      const t = this.host.clientById(client.trackingRedirect);
      if (!t) {
        client.trackingRedirectBroken = true;
        if (client.resp === 3) this.send(client, new RespPush(['tracking-redir-broken', client.trackingRedirect]));
        return;
      }
      target = t;
    }
    if (target === this.current) {
      let queue = this.deferred.get(target);
      if (!queue) this.deferred.set(target, (queue = []));
      queue.push(keys);
      return;
    }
    this.write(target, keys);
  }

  private write(target: Client, keys: string[] | null): void {
    if (target.resp === 3) this.send(target, new RespPush(['invalidate', keys ?? null]));
    else if (target.channels.has(INVALIDATE_CHANNEL)) this.send(target, new RespPush(['message', INVALIDATE_CHANNEL, keys ?? NULL_ARRAY]));
  }

  private send(target: Client, push: Reply): void {
    target.write(push);
  }

  /** Sends what was deferred for `client` (call after its reply was written). */
  flushDeferred(client: Client): void {
    const queue = this.deferred.get(client);
    if (!queue) return;
    this.deferred.delete(client);
    for (const keys of queue) this.write(client, keys);
  }

  /** INFO stats tracking_total_keys / items / prefixes. */
  stats(): { keys: number; items: number; prefixes: number } {
    let items = 0;
    for (const ids of this.table.values()) items += ids.size;
    return { keys: this.table.size, items, prefixes: this.prefixes.size };
  }
}
