import { z } from 'zod';

import { RespMessages } from '@/libs/resp/messages';
import { reject } from '@/libs/schemas';

import { TrackingCachingEnum } from './tracking.enums';

/**
 * Argument grammar of CLIENT TRACKING and CLIENT CACHING (the arguments after the subcommand). Checks that need the
 * client or the server (redirect target exists, mode switches, prefix overlaps) stay in the services.
 */

// ============================================================================
// CLIENT TRACKING
// ============================================================================

/**
 * `ON|OFF [REDIRECT id] [PREFIX p]... [BCAST] [OPTIN] [OPTOUT] [NOLOOP]`, read left to right: the mode first, then
 * each option where it stands (a non-integer REDIRECT id is "not an integer", anything else unknown a syntax error).
 */
export const ClientTrackingDTO = z.array(z.string()).transform((args, ctx) => {
  const mode = args[0].toLowerCase();
  if (mode !== 'on' && mode !== 'off') return reject(ctx, RespMessages.SYNTAX);
  const o = { on: mode === 'on', redirect: 0, bcast: false, optin: false, optout: false, noloop: false, prefixes: [] as string[] };
  for (let i = 1; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    const more = i + 1 < args.length;
    if (opt === 'redirect' && more) {
      const raw = args[++i];
      if (!/^-?\d+$/.test(raw)) return reject(ctx, RespMessages.NOT_INTEGER);
      o.redirect = Number(raw);
    } else if (opt === 'prefix' && more) o.prefixes.push(args[++i]);
    else if (opt === 'bcast') o.bcast = true;
    else if (opt === 'optin') o.optin = true;
    else if (opt === 'optout') o.optout = true;
    else if (opt === 'noloop') o.noloop = true;
    else return reject(ctx, RespMessages.SYNTAX);
  }
  return o;
});

// ============================================================================
// CLIENT CACHING
// ============================================================================

/** `YES|NO` (case-insensitive); anything else is a syntax error, checked before the client's mode. */
export const ClientCachingDTO = z.tuple([z.string()]).transform(([value], ctx) => {
  const parsed = TrackingCachingEnum.safeParse(value.toLowerCase());
  return parsed.success ? { value: parsed.data } : reject(ctx, RespMessages.SYNTAX);
});

// ============================================================================
// Type Exports
// ============================================================================

export type ClientTrackingInput = z.infer<typeof ClientTrackingDTO>;
export type ClientCachingInput = z.infer<typeof ClientCachingDTO>;
