/**
 * Argument grammar of the replication commands (REPLICAOF / SLAVEOF, PSYNC, SYNC, REPLCONF, FAILOVER). Checks that need
 * the server state (role, attached replicas) stay in the services.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { z } from 'zod';

import { formatMessage } from '@/libs/message-format';
import { RespMessages } from '@/libs/resp/messages';
import { IntegerSchema, parseArg, reject } from '@/libs/schemas';

import { ReplconfOptionEnum } from './replication.enums';
import ReplicationMessages from './replication.messages';

// ============================================================================
// Shared Schemas
// ============================================================================

/** A TCP port: an integer (UNCERTAIN: Redis's wording for an out-of-range port; the integer error is used). */
const PortSchema = IntegerSchema.refine((n) => n >= 0 && n <= 65535, { error: RespMessages.NOT_INTEGER });

/** A replication offset (PSYNC, REPLCONF ACK). */
const OffsetSchema = IntegerSchema;

// ============================================================================
// REPLICAOF / SLAVEOF
// ============================================================================

/** REPLICAOF host port | NO ONE (case-insensitive). */
export const ReplicaOfDTO = z.tuple([z.string(), z.string()]).transform(([host, rawPort], ctx) => {
  if (host.toLowerCase() === 'no' && rawPort.toLowerCase() === 'one') return { noOne: true as const };
  const port = parseArg(PortSchema, rawPort);
  return port.ok ? { noOne: false as const, host, port: port.value } : reject(ctx, port.error);
});

// ============================================================================
// PSYNC / REPLCONF
// ============================================================================

/** PSYNC replicationid offset [FAILOVER]: `?` / `-1` asks for a full resync. */
export const PsyncDTO = z.tuple([z.string(), z.string()], z.string()).transform(([replid, rawOffset, ...rest], ctx) => {
  const offset = parseArg(OffsetSchema, rawOffset);
  if (!offset.ok) return reject(ctx, offset.error);
  if (rest.length > 1 || (rest.length === 1 && rest[0].toLowerCase() !== 'failover')) return reject(ctx, RespMessages.SYNTAX);
  return { replid, offset: rawOffset, failover: rest.length === 1 };
});

/** REPLCONF <option> <value> [<option> <value> …]: options in pairs, each one known. */
export const ReplconfDTO = z.array(z.string()).transform((args, ctx) => {
  if (args.length % 2) return reject(ctx, RespMessages.SYNTAX);
  const pairs: Array<{ option: z.infer<typeof ReplconfOptionEnum>; value: string; extra: string[] }> = [];
  for (let i = 0; i < args.length; i += 2) {
    const option = ReplconfOptionEnum.safeParse(args[i].toLowerCase());
    if (!option.success) return reject(ctx, formatMessage(ReplicationMessages.REPLCONF_UNKNOWN, { option: args[i] }));
    // ACK <offset> [FACK <aofoffset>]: FACK is ACK's own pair
    if (option.data === 'ack' && args[i + 2]?.toLowerCase() === 'fack' && i + 3 < args.length) {
      pairs.push({ option: option.data, value: args[i + 1], extra: [args[i + 3]] });
      i += 2;
      continue;
    }
    pairs.push({ option: option.data, value: args[i + 1], extra: [] });
  }
  return { pairs };
});

// ============================================================================
// FAILOVER
// ============================================================================

const FailoverTimeoutSchema = IntegerSchema.refine((n) => n > 0, { error: ReplicationMessages.FAILOVER_TIMEOUT });

/** FAILOVER [TO host port [FORCE]] [ABORT] [TIMEOUT milliseconds]: options in any order, each at most once. */
export const FailoverDTO = z.array(z.string()).transform((args, ctx) => {
  let host: string | null = null;
  let port: number | null = null;
  let force = false;
  let abort = false;
  let timeoutMs = 0;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const opt = args[i].toLowerCase();
    if (seen.has(opt)) return reject(ctx, RespMessages.SYNTAX);
    seen.add(opt);
    if (opt === 'to' && i + 2 < args.length) {
      const p = parseArg(PortSchema, args[i + 2]);
      if (!p.ok) return reject(ctx, p.error);
      host = args[i + 1];
      port = p.value;
      i += 2;
    } else if (opt === 'force') force = true;
    else if (opt === 'abort') abort = true;
    else if (opt === 'timeout' && i + 1 < args.length) {
      const t = parseArg(FailoverTimeoutSchema, args[++i]);
      if (!t.ok) return reject(ctx, t.error);
      timeoutMs = t.value;
    } else return reject(ctx, RespMessages.SYNTAX);
  }
  if (abort && seen.size > 1) return reject(ctx, RespMessages.SYNTAX);
  return { abort, host, port, force, timeoutMs };
});

// ============================================================================
// Type Exports
// ============================================================================

export type ReplicaOfInput = z.infer<typeof ReplicaOfDTO>;
export type PsyncInput = z.infer<typeof PsyncDTO>;
export type ReplconfInput = z.infer<typeof ReplconfDTO>;
export type FailoverInput = z.infer<typeof FailoverDTO>;
