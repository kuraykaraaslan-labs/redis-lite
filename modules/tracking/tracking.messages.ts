/**
 * Every text the tracking module emits, word for word as Redis sends it (CLIENT TRACKING / CACHING errors), plus the
 * Pub/Sub channel and push types invalidations are delivered with. Texts shared with other modules (syntax error, not
 * an integer) live in `@/libs/resp/messages`.
 */
export const TrackingMessages = {
  REDIRECT_MISSING: 'ERR The client ID you want redirect to does not exist',
  PREFIX_WITHOUT_BCAST: 'ERR PREFIX option requires BCAST mode to be enabled',
  BCAST_SWITCH: "ERR You can't switch BCAST mode on/off before disabling tracking for this client, and then re-enabling it with a different mode.",
  OPTIN_AND_OPTOUT: "ERR You can't use both OPTIN and OPTOUT",
  OPTIN_OPTOUT_WITH_BCAST: 'ERR OPTIN and OPTOUT are not compatible with BCAST',
  OPTIN_OPTOUT_SWITCH: "ERR You can't switch OPTIN/OPTOUT mode before disabling tracking for this client, and then re-enabling it with a different mode.",
  PREFIX_OVERLAP: "ERR Prefix '{prefix}' overlaps with an existing prefix '{existing}'. Prefixes for a single client must not overlap.",
  CACHING_NOT_OPT_MODE: 'ERR CLIENT CACHING can be called only when the client is in tracking mode with OPTIN or OPTOUT mode enabled',
  CACHING_YES_NOT_OPTIN: 'ERR CLIENT CACHING YES is only valid when tracking is enabled in OPTIN mode.',
  CACHING_NO_NOT_OPTOUT: 'ERR CLIENT CACHING NO is only valid when tracking is enabled in OPTOUT mode.',

  // Delivery: the RESP2 invalidation channel and the RESP3 push types
  INVALIDATE_CHANNEL: '__redis__:invalidate',
  PUSH_INVALIDATE: 'invalidate',
  PUSH_MESSAGE: 'message',
  PUSH_REDIR_BROKEN: 'tracking-redir-broken',
} as const;

export default TrackingMessages;
