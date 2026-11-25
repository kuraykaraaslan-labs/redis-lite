import { z } from 'zod';

/** A key name: any binary-safe string (latin1, one char per byte). */
export const KeySchema = z.string();

/** A value argument: any binary-safe string. */
export const ValueSchema = z.string();

/** The subcommand token of a container command (CLIENT, CONFIG…), as typed: error texts quote it as sent. */
export const SubcommandSchema = z.string();

export type Key = z.infer<typeof KeySchema>;
