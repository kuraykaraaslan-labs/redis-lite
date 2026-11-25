import { z } from 'zod';

/** CLIENT REPLY modes. */
export const ReplyModeEnum = z.enum(['on', 'off', 'skip']);

/** CLIENT SETINFO attributes. */
export const ClientAttributeEnum = z.enum(['lib-name', 'lib-ver']);

/** CLIENT UNBLOCK reasons: answer with the timeout reply or with an UNBLOCKED error. */
export const UnblockReasonEnum = z.enum(['timeout', 'error']);

/** CLIENT PAUSE modes. */
export const PauseModeEnum = z.enum(['write', 'all']);

export type ReplyMode = z.infer<typeof ReplyModeEnum>;
export type ClientAttribute = z.infer<typeof ClientAttributeEnum>;
