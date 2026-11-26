import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll } from 'vitest';

import Redis from 'ioredis';

import { RedisLite } from '@/index';
import type { RedisLiteOptions } from '@/index';

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

/** A fresh temporary directory, removed when the test file ends (servers never write into the repository). */
export function tempDir(prefix = 'redis-lite-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function useServer(options: RedisLiteOptions = {}): TestServer {
  const extra: Array<{ close(): void }> = [];
  const t = {} as TestServer;
  const dir = tempDir();
  beforeAll(async () => {
    // a temp dir for SAVE / BGSAVE / AOF; no save points unless the test asks for them
    t.server = await RedisLite.start({ port: 0, dir, save: '', ...options });
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

  /**
   * Waits for bytes (or `timeoutMs`), then until the bytes form whole RESP replies and nothing new arrived for
   * `settleMs`; returns everything received so far. The completeness wait (capped by `timeoutMs`) keeps a reply that a
   * loaded machine delivers in several chunks from being cut short.
   */
  async read(timeoutMs = 10_000, settleMs = 25): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    if (!this.buffer) await this.nextData(timeoutMs);
    for (;;) {
      const seen = this.buffer.length;
      await sleep(settleMs);
      if (this.buffer.length === seen && (!this.buffer || wholeResp(this.buffer))) break;
      if (Date.now() > deadline) break;
    }
    const out = this.buffer;
    this.buffer = '';
    return out;
  }

  private nextData(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /**
   * Everything the server sent so far (pushes, messages), without guessing a delay: sends a PING and returns what
   * arrived before its reply. A connection's output is ordered, so whatever the server wrote to it before handling the
   * PING is in the result, and an empty result proves nothing was sent.
   */
  async drain(): Promise<string> {
    this.socket.write('*1\r\n$4\r\nPING\r\n', 'latin1');
    // +PONG, or the RESP2 Pub/Sub form of a subscribed connection
    const pong = /(\+PONG\r\n|\*2\r\n\$4\r\npong\r\n\$0\r\n\r\n)$/;
    await waitFor(() => pong.test(this.buffer) && wholeResp(this.buffer));
    const out = this.buffer.replace(pong, '');
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

/** End offset of the RESP value starting at `i`, or -1 when the bytes stop before it ends. */
function respEnd(buf: string, i: number): number {
  const eol = buf.indexOf('\r\n', i);
  if (eol < 0) return -1;
  const type = buf[i];
  const head = buf.slice(i + 1, eol);
  let next = eol + 2;
  if (type === '$' || type === '!' || type === '=') {
    const len = Number(head);
    if (len < 0) return next;
    return buf.length >= next + len + 2 ? next + len + 2 : -1;
  }
  const pairs = type === '%' || type === '|' ? 2 : 1;
  if (type === '*' || type === '~' || type === '>' || pairs === 2) {
    const n = Number(head);
    for (let k = 0; k < Math.max(n, 0) * pairs; k++) {
      next = respEnd(buf, next);
      if (next < 0) return -1;
    }
    // an attribute (|) precedes the value it annotates
    return type === '|' ? respEnd(buf, next) : next;
  }
  return next; // simple types: + - : _ # , (
}

/** True when `buf` is a sequence of complete RESP values (no reply cut in the middle). */
export function wholeResp(buf: string): boolean {
  let i = 0;
  while (i < buf.length) {
    i = respEnd(buf, i);
    if (i < 0) return false;
  }
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Waiting for conditions (never a fixed sleep: a loaded machine can be arbitrarily slow)
// ============================================================================

export interface WaitOptions {
  /** Give up after this many ms (generous: it only matters when the condition never holds). */
  timeout?: number;
  /** Poll interval in ms. */
  interval?: number;
}

/** Polls `fn` until it returns a truthy value and returns that value; throws after `timeout` ms. */
export async function waitFor<T>(fn: () => T | Promise<T>, { timeout = 10_000, interval = 10 }: WaitOptions = {}): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeout} ms`);
    await sleep(interval);
  }
}

/** Retries `assertion` until it stops throwing; after `timeout` ms the last failure is rethrown. */
export async function eventually<T>(assertion: () => T | Promise<T>, { timeout = 10_000, interval = 10 }: WaitOptions = {}): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await assertion();
    } catch (e) {
      if (Date.now() > deadline) throw e;
    }
    await sleep(interval);
  }
}

/** Anything that can send a command: a `TestServer`, or `{ call }` in a suite that starts its own server. */
type Caller = { call: (...args: string[]) => Promise<unknown> };

/** The server clock (TIME) in ms: the clock TTLs are checked against. */
export async function serverTime(t: Caller): Promise<number> {
  const [sec, usec] = (await t.call('TIME')) as [string, string];
  return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
}

/**
 * Waits until the server clock is past `atMs` (an absolute expire time, e.g. from PEXPIRETIME), without touching any
 * key. Safer than sleeping for the TTL: the wall clock TTLs use can be stepped back (NTP / WSL time sync) while a
 * test sleeps, so a fixed sleep does not guarantee the key has expired.
 */
export async function waitForServerTime(t: Caller, atMs: number, options?: WaitOptions): Promise<void> {
  await waitFor(async () => (await serverTime(t)) > atMs, options);
}

/**
 * Waits until the TTL of `key` has run out. The key is read once (PEXPIRETIME) and then left alone, so the expiry is
 * noticed by whatever the test does next, not by the wait.
 */
export async function waitPastExpiry(t: Caller, key: string, options?: WaitOptions): Promise<void> {
  const at = Number(await t.call('PEXPIRETIME', key));
  if (at === -1) throw new Error(`waitPastExpiry: ${key} has no TTL`);
  if (at >= 0) await waitForServerTime(t, at, options); // -2: already gone
}

/** Number of clients currently blocked (BLPOP, XREAD BLOCK, WAIT…), from INFO clients. */
export async function blockedClients(t: Caller): Promise<number> {
  const info = String(await t.call('INFO', 'clients'));
  return Number(/blocked_clients:(\d+)/.exec(info)?.[1] ?? 0);
}

/** Waits until at least `n` clients are blocked: the race-free way to know a blocking command reached the server. */
export async function waitForBlocked(t: Caller, n = 1, options?: WaitOptions): Promise<void> {
  await waitFor(async () => (await blockedClients(t)) >= n, options);
}

// ============================================================================
// Error-reply helpers (expected texts are written out, never imported: the tests are the oracle)
// ============================================================================

/** Resolves to the error message of a rejected call (fails if the call succeeds). */
export async function err(p: Promise<unknown>): Promise<string> {
  try {
    const v = await p;
    return `NO ERROR, got ${JSON.stringify(v)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

export const arity = (cmd: string): string => `ERR wrong number of arguments for '${cmd}' command`;
export const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
export const SYNTAX = 'ERR syntax error';
export const NOT_INT = 'ERR value is not an integer or out of range';
export const NOT_FLOAT = 'ERR value is not a valid float';

/** A raw connection switched to RESP3 (HELLO 3 already sent). */
export async function resp3Client(t: TestServer): Promise<RawClient> {
  const r = await t.raw();
  await r.send('HELLO', '3');
  return r;
}
