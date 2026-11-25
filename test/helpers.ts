import { connect } from 'node:net';
import type { Socket } from 'node:net';

import Redis from 'ioredis';
import { afterAll, beforeAll } from 'vitest';

import { RedisLite } from '../src/index';
import type { RedisLiteOptions } from '../src/index';

/**
 * Shared test setup. Every test file gets its own isolated server:
 *
 *   const t = useServer();
 *   it('…', async () => { expect(await t.call('GET', 'k')).toBeNull(); });
 *
 * - `t.redis`: ioredis client (RESP2), for typed convenience methods.
 * - `t.call(...)`: send any command through ioredis and get the parsed reply (errors reject).
 * - `t.raw()`: a raw socket client returning the exact bytes the server sends (use for RESP3 and wire-level checks).
 * - `t.client()`: an extra ioredis connection (closed automatically).
 */
export interface TestServer {
  server: RedisLite;
  redis: Redis;
  call: (...args: Array<string | number | Buffer>) => Promise<unknown>;
  client: () => Redis;
  raw: () => Promise<RawClient>;
}

export function useServer(options: RedisLiteOptions = {}): TestServer {
  const extra: Array<{ close(): void }> = [];
  const t = {} as TestServer;
  beforeAll(async () => {
    t.server = await RedisLite.start({ port: 0, ...options });
    t.redis = new Redis(t.server.url, { maxRetriesPerRequest: null });
    t.call = (...args) => t.redis.call(String(args[0]), ...args.slice(1).map((a) => (Buffer.isBuffer(a) ? a : String(a))));
    t.client = () => {
      const c = new Redis(t.server.url, { maxRetriesPerRequest: null });
      extra.push({ close: () => c.disconnect() });
      return c;
    };
    t.raw = async () => {
      const r = await RawClient.open(t.server.port);
      extra.push(r);
      return r;
    };
  });
  afterAll(async () => {
    for (const c of extra) c.close();
    t.redis?.disconnect();
    await t.server?.close();
  });
  return t;
}

/** Raw RESP client: sends commands, returns the exact reply bytes (latin1). */
export class RawClient {
  private buffer = '';
  private waiters: Array<() => void> = [];

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => {
      this.buffer += d;
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static open(port: number): Promise<RawClient> {
    return new Promise((resolve) => {
      const s = connect(port, '127.0.0.1', () => resolve(new RawClient(s)));
    });
  }

  /** Sends one command and returns the bytes received within `settleMs` after the first byte arrives. */
  async send(...args: Array<string | number>): Promise<string> {
    this.buffer = '';
    const parts = args.map(String);
    this.socket.write(`*${parts.length}\r\n${parts.map((a) => `$${Buffer.byteLength(a, 'latin1')}\r\n${a}\r\n`).join('')}`, 'latin1');
    return this.read();
  }

  /** Waits for bytes (or `timeoutMs`), then lets the stream settle and returns everything received so far. */
  async read(timeoutMs = 1000, settleMs = 25): Promise<string> {
    if (!this.buffer) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    await new Promise((r) => setTimeout(r, settleMs));
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  /** Bytes received and not yet read, without waiting. */
  pending(): string {
    return this.buffer;
  }

  close(): void {
    this.socket.destroy();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
