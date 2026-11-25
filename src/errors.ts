/** Thrown inside a command handler to answer the client with an error reply (`-<message>`). */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}
