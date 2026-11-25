import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';

import type { Client } from '@/modules/server/server.service';

import type { ClientCachingInput, ClientTrackingInput } from './tracking.dto';
import TrackingMessages from './tracking.messages';
import type { TrackingInfo, TrackingState } from './tracking.types';

/** A client's tracking mode: CLIENT TRACKING ON / OFF (and RESET, disconnection), CLIENT CACHING, CLIENT TRACKINGINFO. */
export default class TrackingClientService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Prefixes of one client must not overlap (one being a prefix of another). */
  private static checkPrefixes(client: Client, added: string[]): void {
    const overlaps = (a: string, b: string): boolean => a !== b && (a.startsWith(b) || b.startsWith(a));
    const overlapError = (prefix: string, existing: string): AppError =>
      new AppError(formatMessage(TrackingMessages.PREFIX_OVERLAP, { prefix, existing }));
    for (let i = 0; i < added.length; i++) {
      const p = added[i];
      for (const existing of client.trackingPrefixes) {
        if (overlaps(p, existing)) throw overlapError(p, existing);
      }
      for (let j = 0; j < i; j++) {
        if (overlaps(p, added[j])) throw overlapError(p, added[j]);
      }
    }
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** CLIENT TRACKING: validates like Redis, then enables or disables. */
  static configure(state: TrackingState, client: Client, o: ClientTrackingInput): void {
    if (!o.on) {
      TrackingClientService.disable(state, client);
      return;
    }
    if (o.redirect !== 0 && !state.host.clientById(o.redirect)) throw new AppError(TrackingMessages.REDIRECT_MISSING);
    if (o.prefixes.length && !o.bcast) throw new AppError(TrackingMessages.PREFIX_WITHOUT_BCAST);
    if (client.tracking) {
      if (client.trackingBcast !== o.bcast) throw new AppError(TrackingMessages.BCAST_SWITCH);
    }
    if (o.optin && o.optout) throw new AppError(TrackingMessages.OPTIN_AND_OPTOUT);
    if (o.bcast && (o.optin || o.optout)) throw new AppError(TrackingMessages.OPTIN_OPTOUT_WITH_BCAST);
    if (client.tracking && ((o.optin && client.trackingOptout) || (o.optout && client.trackingOptin))) {
      throw new AppError(TrackingMessages.OPTIN_OPTOUT_SWITCH);
    }
    if (o.bcast) TrackingClientService.checkPrefixes(client, o.prefixes);

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
        let entry = state.prefixes.get(p);
        if (!entry) state.prefixes.set(p, (entry = { clients: new Set(), pending: new Map() }));
        entry.clients.add(client);
      }
    }
  }

  /** CLIENT TRACKING OFF, RESET, disconnection. Remembered keys stay in the table and are skipped lazily. */
  static disable(state: TrackingState, client: Client): void {
    for (const p of client.trackingPrefixes) {
      const entry = state.prefixes.get(p);
      if (!entry) continue;
      entry.clients.delete(client);
      if (!entry.clients.size) state.prefixes.delete(p);
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
    state.deferred.delete(client);
  }

  /** CLIENT CACHING YES|NO (the value already parsed by ClientCachingDTO). */
  static caching(client: Client, { value }: ClientCachingInput): void {
    if (!client.tracking || !(client.trackingOptin || client.trackingOptout)) throw new AppError(TrackingMessages.CACHING_NOT_OPT_MODE);
    if (value === 'yes' && !client.trackingOptin) throw new AppError(TrackingMessages.CACHING_YES_NOT_OPTIN);
    if (value === 'no' && !client.trackingOptout) throw new AppError(TrackingMessages.CACHING_NO_NOT_OPTOUT);
    client.trackingCaching = value;
  }

  /** CLIENT TRACKINGINFO. */
  static info(client: Client): TrackingInfo {
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
}
