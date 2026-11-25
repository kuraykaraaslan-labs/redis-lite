import { z } from 'zod';

import { RespError } from '@/libs/resp';
import { RespMessages } from '@/libs/resp/messages';

/** Inside a `.transform()`: records `message` (a Redis error text) as the validation error and aborts the parse. */
export function reject(ctx: z.core.$RefinementCtx, message: string): never {
  ctx.addIssue({ code: 'custom', message });
  return z.NEVER;
}

/** The Redis error text of a failed parse: Redis reports only the first problem it meets, in argument order. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? RespMessages.SYNTAX;
}

/** The error reply of a failed DTO parse (validation errors are returned as replies, never thrown). */
export function validationErrorReply(error: z.ZodError): RespError {
  return new RespError(firstIssue(error));
}
