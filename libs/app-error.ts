/**
 * The error a service throws to answer the client with an error reply (`-<message>\r\n`).
 *
 * `message` is the full Redis error text, prefix included (`ERR …`, `WRONGTYPE …`, `NOSCRIPT …`): clients and libraries
 * such as BullMQ match on it. There is no HTTP status: the prefix is the error class. The dispatcher turns an AppError
 * into an error reply; any other exception is an internal error (logged, then answered as `ERR <message>`).
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * @deprecated Step-1 alias so modules that are not converted yet keep compiling. Step 2 replaces every use with
 * AppError and deletes this alias (see docs/STRUCTURE.md).
 */
export const CommandError = AppError;
/** @deprecated See {@link CommandError}. */
export type CommandError = AppError;

export default AppError;
