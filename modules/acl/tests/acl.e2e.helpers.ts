import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import { afterAll, expect } from 'vitest';

import { sleep, wholeResp } from '@/tests/helpers';
import type { TestServer } from '@/tests/helpers';

/** Shared helpers of the end-to-end ACL suites: raw RESP connections, logins, ACL LOG as objects. */

// ============================================================================
// Raw connections
// ============================================================================

/** Raw RESP connection that also notices when the server closes it. */
export class Conn {
  private buffer = '';
  private waiters: Array<() => void> = [];
  closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => {
      this.buffer += d;
      for (const w of this.waiters.splice(0)) w();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static open(port: number): Promise<Conn> {
    return new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => resolve(new Conn(s)));
    });
  }

  async send(...args: Array<string | number>): Promise<string> {
    this.buffer = '';
    const parts = args.map(String);
    const payload = `*${parts.length}\r\n${parts.map((a) => `$${Buffer.byteLength(a, 'latin1')}\r\n${a}\r\n`).join('')}`;
    if (!this.closed) this.socket.write(payload, 'latin1');
    // generous caps: on a loaded machine a reply can take seconds; the wait ends as soon as it is complete
    const deadline = Date.now() + 10_000;
    if (!this.buffer && !this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    for (;;) {
      const seen = this.buffer.length;
      await sleep(15);
      if ((this.buffer.length === seen && wholeResp(this.buffer)) || Date.now() > deadline) break;
    }
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /** Resolves once the server has closed the connection (false after `ms`). */
  async waitClosed(ms = 10_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (!this.closed && Date.now() < until) await sleep(10);
    return this.closed;
  }

  close(): void {
    this.socket.destroy();
  }
}

// ============================================================================
// Reply and error helpers
// ============================================================================

export const sha = (pw: string): string => createHash('sha256').update(pw).digest('hex');

export async function errOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return 'NO ERROR';
}

export const bulk = (s: string): string => `$${s.length}\r\n${s}\r\n`;
export const err = (s: string): string => `-${s}\r\n`;

// ============================================================================
// Per-suite helpers (bound to the suite's server)
// ============================================================================

/** Helpers bound to `t`; raw connections are closed after the suite. */
export function useAclHelpers(t: TestServer) {
  const conns: Conn[] = [];
  afterAll(() => {
    for (const c of conns) c.close();
  });

  async function raw(port?: number): Promise<Conn> {
    const c = await Conn.open(port ?? t.server.port);
    conns.push(c);
    return c;
  }

  /** A raw connection authenticated as `user` (password `pw`). */
  async function login(user: string, pw: string): Promise<Conn> {
    const r = await raw();
    expect(await r.send('AUTH', user, pw)).toBe('+OK\r\n');
    return r;
  }

  /** ACL LOG entries (RESP2) as objects. */
  async function aclLog(count?: number): Promise<Array<Record<string, unknown>>> {
    const raw = (count === undefined ? await t.call('ACL', 'LOG') : await t.call('ACL', 'LOG', count)) as unknown[][];
    return raw.map((flat) => {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < flat.length; i += 2) o[String(flat[i])] = flat[i + 1];
      return o;
    });
  }

  function closed(r: Conn): Promise<boolean> {
    return r.waitClosed();
  }

  return { raw, login, aclLog, closed };
}
