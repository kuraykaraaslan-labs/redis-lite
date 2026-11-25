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

export default AppError;
