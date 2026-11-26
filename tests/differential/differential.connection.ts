import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { encodeCommand, respEnd } from './differential.resp';

/**
 * The port of the user's own Redis instance. The harness never connects to it: every connection goes through
 * `assertSafePort`, so a bug that would point the harness at it throws instead.
 */
export const FORBIDDEN_PORT = 6379;

export function assertSafePort(port: number): void {
  if (port === FORBIDDEN_PORT || !Number.isInteger(port) || port <= 0) {
    throw new Error(`differential harness: refusing to use port ${port}`);
  }
}

/** Reply placeholder when no whole reply arrived in time. */
export const TIMEOUT = '<TIMEOUT>';
/** Reply placeholder when the server closed the connection before a whole reply. */
export const CLOSED = '<CLOSED>';

/**
 * A raw RESP connection that frames replies exactly: `reply()` returns the bytes of the next whole RESP value (an
 * attribute together with the value it annotates), so no settle delay is involved and a slow machine cannot cut a
 * reply short. Bytes are latin1 strings (one char per byte).
 */
export class DiffConnection {
  private buffer = '';
  private closed = false;
  private wake: (() => void) | undefined;

  private constructor(private readonly socket: Socket) {
    socket.setNoDelay(true);
    socket.on('data', (d: Buffer) => {
      this.buffer += d.toString('latin1');
      this.wake?.();
    });
    const end = (): void => {
      this.closed = true;
      this.wake?.();
    };
    socket.on('close', end);
    socket.on('error', end);
  }

  static open(port: number, timeoutMs = 5_000): Promise<DiffConnection> {
    assertSafePort(port);
    return new Promise((resolve, reject) => {
      const s = connect(port, '127.0.0.1');
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`connect to 127.0.0.1:${port} timed out`));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(new DiffConnection(s));
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  send(args: string[]): void {
    if (!this.closed) this.socket.write(encodeCommand(args), 'latin1');
  }

  /** The next whole reply, or TIMEOUT / CLOSED. */
  async reply(timeoutMs = 5_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = respEnd(this.buffer, 0);
      if (end > 0) {
        const out = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end);
        return out;
      }
      if (this.closed) return CLOSED;
      const left = deadline - Date.now();
      if (left <= 0) return TIMEOUT;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = undefined;
          resolve();
        };
      });
    }
  }

  /** Sends one command and returns its reply. */
  async call(args: string[], timeoutMs?: number): Promise<string> {
    this.send(args);
    return this.reply(timeoutMs);
  }

  /** True when bytes arrived that no `reply()` consumed yet. */
  hasPending(): boolean {
    return this.buffer.length > 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.socket.destroy();
  }
}
