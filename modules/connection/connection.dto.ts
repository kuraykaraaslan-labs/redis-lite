import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { isInteger } from '@/libs/number';
import type { Protocol } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, ValueSchema, firstIssue, reject } from '@/libs/schemas';

import CommandService from '@/modules/command/command.service';
import { SubcommandSchema } from '@/modules/command/command.dto';

import { ClientAttributeEnum, PauseModeEnum, ReplyModeEnum, UnblockReasonEnum } from './connection.enums';
import ConnectionMessages from './connection.messages';
import type { ClientKillFilters } from './connection.types';

/**
 * Argument grammar of the connection commands. CLIENT's DTOs parse the whole `args`, subcommand included (error texts
 * quote it as typed). Checks that need the server (users, clients, databases) stay in the services.
 */

// ============================================================================
// Shared Schemas
// ============================================================================

/** Redis validateClientAttr(): only printable ASCII without spaces ('!'..'~'). */
function validAttr(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 33 || c > 126) return false;
  }
  return true;
}

/** A strict Redis integer whose error text is command specific. */
function IntegerArgSchema(message: string) {
  return z
    .string()
    .refine(isInteger, { error: message })
    .transform((value) => Number(value));
}

const ClientNameSchema = z.string().refine(validAttr, { error: ConnectionMessages.NAME_INVALID });

/** CLIENT LIST / KILL TYPE values → the type Redis reports (slave is an alias of replica). */
const CLIENT_TYPES: Record<string, string> = { normal: 'normal', slave: 'replica', replica: 'replica', master: 'master', pubsub: 'pubsub' };

const ClientIdSchema = IntegerArgSchema(ConnectionMessages.CLIENT_ID_INVALID);
const PauseTimeoutSchema = IntegerArgSchema(ConnectionMessages.PAUSE_TIMEOUT_NOT_INTEGER);
const ProtocolSchema = IntegerArgSchema(ConnectionMessages.HELLO_PROTOCOL_NOT_INTEGER).refine((v) => v === 2 || v === 3, {
  error: ConnectionMessages.NOPROTO,
});

const PING_ARITY = formatMessage(RespMessages.WRONG_ARITY, { command: 'ping' });

/** Redis addReplySubcommandSyntaxError() for CLIENT, the subcommand as typed. */
function clientSyntax(sub: string): string {
  return CommandService.subcommandSyntaxMessage(sub, 'client');
}

// ============================================================================
// Session DTOs: PING, ECHO, SELECT
// ============================================================================

export const PingDTO = z.array(ValueSchema).transform((args, ctx) => (args.length > 1 ? reject(ctx, PING_ARITY) : { message: args[0] }));

export const EchoDTO = z.tuple([ValueSchema]).transform(([message]) => ({ message }));

export const SelectDTO = z.tuple([IntegerSchema]).transform(([index]) => ({ index }));

// ============================================================================
// Auth DTOs: AUTH, HELLO
// ============================================================================

/** AUTH [username] password: without a username the default user is meant. */
export const AuthDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length > 2) return reject(ctx, RespMessages.SYNTAX);
  return args.length === 1 ? { username: null, password: args[0] } : { username: args[0], password: args[1] };
});

/** HELLO [protover [AUTH username password] [SETNAME clientname]]: options read left to right. */
export const HelloDTO = z.array(z.string()).transform((args, ctx) => {
  let protocol: Protocol | null = null;
  if (args.length) {
    const version = ProtocolSchema.safeParse(args[0]);
    if (!version.success) return reject(ctx, firstIssue(version.error));
    protocol = version.data as Protocol;
  }
  let auth: { username: string; password: string } | null = null;
  let name: string | null = null;
  for (let i = 1; i < args.length; i++) {
    const option = args[i].toLowerCase();
    const more = args.length - 1 - i;
    if (option === 'auth' && more >= 2) {
      auth = { username: args[i + 1], password: args[i + 2] };
      i += 2;
    } else if (option === 'setname' && more >= 1) {
      name = args[++i];
      if (!validAttr(name)) return reject(ctx, ConnectionMessages.NAME_INVALID);
    } else return reject(ctx, formatMessage(ConnectionMessages.HELLO_SYNTAX, { option: args[i] }));
  }
  return { protocol, auth, name };
});

// ============================================================================
// Client DTOs: CLIENT SETNAME, SETINFO, REPLY, NO-TOUCH, NO-EVICT, PAUSE, TRACKING, CACHING
// ============================================================================

export const ClientSetNameDTO = z.tuple([SubcommandSchema, ClientNameSchema]).transform(([, name]) => ({ name }));

export const ClientSetInfoDTO = z.tuple([SubcommandSchema, z.string(), z.string()]).transform(([, option, value], ctx) => {
  const attr = ClientAttributeEnum.safeParse(option.toLowerCase());
  if (!attr.success) return reject(ctx, formatMessage(ConnectionMessages.SETINFO_UNRECOGNIZED, { option }));
  if (!validAttr(value)) return reject(ctx, formatMessage(ConnectionMessages.SETINFO_INVALID, { option }));
  return { attr: attr.data, value };
});

export const ClientReplyDTO = z.tuple([SubcommandSchema, z.string()]).transform(([, mode], ctx) => {
  const parsed = ReplyModeEnum.safeParse(mode.toLowerCase());
  return parsed.success ? { mode: parsed.data } : reject(ctx, RespMessages.SYNTAX);
});

/** CLIENT NO-TOUCH / NO-EVICT (ON|OFF). */
export const ClientOnOffDTO = z.tuple([SubcommandSchema, z.string()]).transform(([, value], ctx) => {
  const v = value.toLowerCase();
  if (v !== 'on' && v !== 'off') return reject(ctx, RespMessages.SYNTAX);
  return { on: v === 'on' };
});

/** CLIENT PAUSE timeout [WRITE|ALL]: pausing is accepted and has no effect (one client is served at a time anyway). */
export const ClientPauseDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length > 3) return reject(ctx, clientSyntax(args[0]));
  const timeout = PauseTimeoutSchema.safeParse(args[1]);
  if (!timeout.success) return reject(ctx, firstIssue(timeout.error));
  if (timeout.data < 0) return reject(ctx, ConnectionMessages.TIMEOUT_NEGATIVE);
  if (args.length === 3 && !PauseModeEnum.safeParse(args[2].toLowerCase()).success) return reject(ctx, RespMessages.SYNTAX);
  return { timeout: timeout.data };
});

/** CLIENT TRACKING: the options are parsed by the tracking module. */
export const ClientTrackingDTO = z.tuple([SubcommandSchema], z.string()).transform(([, ...options]) => ({ options }));

export const ClientCachingDTO = z.tuple([SubcommandSchema, z.string()]).transform(([, value]) => ({ value }));

// ============================================================================
// Client Admin DTOs: CLIENT LIST, KILL, UNBLOCK
// ============================================================================

/** CLIENT LIST [TYPE type | ID id [id …]] */
export const ClientListDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length === 3 && args[1].toLowerCase() === 'type') {
    const type = CLIENT_TYPES[args[2].toLowerCase()];
    if (!type) return reject(ctx, formatMessage(ConnectionMessages.CLIENT_TYPE_UNKNOWN, { type: args[2] }));
    return { type, ids: null };
  }
  if (args.length > 2 && args[1].toLowerCase() === 'id') {
    const ids: number[] = [];
    for (const raw of args.slice(2)) {
      const id = ClientIdSchema.safeParse(raw);
      if (!id.success) return reject(ctx, firstIssue(id.error));
      ids.push(id.data);
    }
    return { type: null, ids };
  }
  if (args.length !== 1) return reject(ctx, RespMessages.SYNTAX);
  return { type: null, ids: null };
});

/**
 * CLIENT KILL addr:port | CLIENT KILL <option> <value> […]. Options are read left to right. A USER value must name an
 * existing user, which only the service can check, and Redis reports whichever problem comes first: so a grammar error
 * found after USER options is not rejected here but handed over as `error`, for the service to report once the users
 * before it were checked.
 */
export const ClientKillDTO = z.array(z.string()).transform((args) => {
  if (args.length === 2) return { address: args[1], filters: null, error: null };
  const filters: ClientKillFilters = { id: null, type: null, addr: null, laddr: null, users: [], maxAge: null, skipMe: true };
  const fail = (error: string) => ({ address: null, filters, error });
  for (let i = 1; i < args.length; i += 2) {
    const option = args[i].toLowerCase();
    const value = args[i + 1];
    if (value === undefined) return fail(RespMessages.SYNTAX);
    if (option === 'id') {
      if (!/^-?\d+$/.test(value) || Number(value) < 1) return fail(ConnectionMessages.CLIENT_ID_POSITIVE);
      filters.id = Number(value);
    } else if (option === 'type') {
      const type = CLIENT_TYPES[value.toLowerCase()];
      if (!type) return fail(formatMessage(ConnectionMessages.CLIENT_TYPE_UNKNOWN, { type: value }));
      filters.type = type;
    } else if (option === 'addr') filters.addr = value;
    else if (option === 'laddr') filters.laddr = value;
    else if (option === 'user') filters.users.push(value);
    else if (option === 'skipme') {
      const v = value.toLowerCase();
      if (v !== 'yes' && v !== 'no') return fail(RespMessages.SYNTAX);
      filters.skipMe = v === 'yes';
    } else if (option === 'maxage') {
      const maxAge = IntegerSchema.safeParse(value);
      if (!maxAge.success) return fail(firstIssue(maxAge.error));
      filters.maxAge = maxAge.data;
    } else return fail(RespMessages.SYNTAX);
  }
  return { address: null, filters, error: null };
});

/** CLIENT UNBLOCK client-id [TIMEOUT|ERROR] */
export const ClientUnblockDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length > 3) return reject(ctx, clientSyntax(args[0]));
  let withError = false;
  if (args.length === 3) {
    const reason = UnblockReasonEnum.safeParse(args[2].toLowerCase());
    if (!reason.success) return reject(ctx, ConnectionMessages.UNBLOCK_REASON);
    withError = reason.data === 'error';
  }
  const id = IntegerSchema.safeParse(args[1]);
  return id.success ? { id: id.data, withError } : reject(ctx, firstIssue(id.error));
});

// ============================================================================
// Type Exports
// ============================================================================

export type PingInput = z.infer<typeof PingDTO>;
export type EchoInput = z.infer<typeof EchoDTO>;
export type SelectInput = z.infer<typeof SelectDTO>;
export type AuthInput = z.infer<typeof AuthDTO>;
export type HelloInput = z.infer<typeof HelloDTO>;
export type ClientSetNameInput = z.infer<typeof ClientSetNameDTO>;
export type ClientSetInfoInput = z.infer<typeof ClientSetInfoDTO>;
export type ClientReplyInput = z.infer<typeof ClientReplyDTO>;
export type ClientOnOffInput = z.infer<typeof ClientOnOffDTO>;
export type ClientPauseInput = z.infer<typeof ClientPauseDTO>;
export type ClientTrackingInput = z.infer<typeof ClientTrackingDTO>;
export type ClientCachingInput = z.infer<typeof ClientCachingDTO>;
export type ClientListInput = z.infer<typeof ClientListDTO>;
export type ClientKillInput = z.infer<typeof ClientKillDTO>;
export type ClientUnblockInput = z.infer<typeof ClientUnblockDTO>;
