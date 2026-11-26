import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { sleep, waitFor, wholeResp } from '@/tests/helpers';

/** Helpers shared by the connection suites. */

/** Encodes one command as a RESP array of bulk strings. */
export function enc(...args: Array<string | number>): string {
  const parts = args.map(String);
  return `*${parts.length}\r\n${parts.map((a) => `$${Buffer.byteLength(a, 'latin1')}\r\n${a}\r\n`).join('')}`;
}

/** Bare socket for pipelining, inline commands and connection-close checks. */
export class Sock {
  buffer = '';
  closed = false;
  private constructor(private readonly socket: Socket) {
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => {
      this.buffer += d;
    });
    socket.on('close', () => {
      this.closed = true;
    });
  }

  static open(port: number): Promise<Sock> {
    return new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => resolve(new Sock(s)));
    });
  }

  /**
   * Writes raw bytes and returns the reply: waits until bytes arrived, form whole RESP replies and nothing new came for
   * `ms` (capped at 10 s, or until the connection closes), so a loaded machine does not cut a reply short.
   */
  async write(data: string, ms = 20): Promise<string> {
    this.buffer = '';
    this.socket.write(data, 'latin1');
    const deadline = Date.now() + 10_000;
    let seen = -1;
    while (!(this.buffer.length > 0 && this.buffer.length === seen && wholeResp(this.buffer)) && !this.closed && Date.now() < deadline) {
      seen = this.buffer.length;
      await sleep(ms);
    }
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /** Resolves to true once the server closed the connection (false if it stays open for 10 s). */
  waitClosed(): Promise<boolean> {
    return waitFor(() => this.closed).catch(() => false);
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Returns the error message a promise rejects with. */
export async function errOf(p: Promise<unknown>): Promise<string> {
  let res: unknown;
  try {
    res = await p;
  } catch (e) {
    return (e as Error).message;
  }
  return `<no error, got ${JSON.stringify(res)}>`;
}

/** Converts a flat [k, v, k, v] RESP2 array into an object. */
export function pairs(arr: unknown): Record<string, unknown> {
  const a = arr as unknown[];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < a.length; i += 2) out[String(a[i])] = a[i + 1];
  return out;
}
