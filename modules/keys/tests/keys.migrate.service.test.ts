import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { err, NOT_INT, SYNTAX, eventually, tempDir, useServer } from '@/tests/helpers';

/**
 * MIGRATE (keys.migrate.service) and RESTORE-ASKING. The target is a fake server in a worker thread (MIGRATE blocks
 * the server's thread, as in Redis, so the target cannot live on it): it records what it receives and answers +OK, or
 * an error for the keys named by its mode. Byte-for-byte parity with Redis 7.0.15 is checked by
 * tests/differential/keys.migrate.differential.test.ts.
 */

const FAKE_TARGET = String.raw`
const net = require('node:net');
const { parentPort } = require('node:worker_threads');
let failKeys = [];
const log = [];
const server = net.createServer((sock) => {
  sock.on('error', () => {});
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    for (;;) {
      if (!buf.startsWith('*')) return;
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const n = Number(buf.slice(1, i));
      let p = i + 2;
      const args = [];
      for (let k = 0; k < n; k++) {
        const e = buf.indexOf('\r\n', p);
        if (e < 0) return;
        const len = Number(buf.slice(p + 1, e));
        if (buf.length < e + 4 + len) return;
        args.push(buf.slice(e + 2, e + 2 + len));
        p = e + 4 + len;
      }
      buf = buf.slice(p);
      log.push(args[0] === 'RESTORE' ? [args[0], args[1], args[2], ...args.slice(4)] : args);
      sock.write(args[0] === 'RESTORE' && failKeys.includes(args[1]) ? '-ERR no ' + args[1] + '\r\n' : '+OK\r\n');
    }
  });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
parentPort.on('message', (m) => {
  if (m.fail) failKeys = m.fail;
  parentPort.postMessage({ log: log.splice(0) });
});
`;

class FakeTarget {
  port = 0;
  private worker!: Worker;

  async start(): Promise<void> {
    this.worker = new Worker(FAKE_TARGET, { eval: true });
    this.port = (await this.next()).port as number;
  }

  /** What the target received since the last call (RESTOREs without their payload); `fail`: keys to refuse from now. */
  async received(fail?: string[]): Promise<string[][]> {
    this.worker.postMessage({ fail });
    return (await this.next()).log as string[][];
  }

  async stop(): Promise<void> {
    await this.worker.terminate();
  }

  private next(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => this.worker.once('message', resolve));
  }
}

const dir = tempDir();
const t = useServer({ appendonly: true, dir });
const target = new FakeTarget();
const host = '127.0.0.1';

beforeAll(() => target.start());
afterAll(() => target.stop());

/** The commands of the AOF's incremental files, as written. */
function aofText(): string {
  const aofDir = join(dir, 'appendonlydir');
  return readdirSync(aofDir)
    .filter((f) => f.endsWith('.incr.aof'))
    .map((f) => readFileSync(join(aofDir, f), 'latin1'))
    .join('');
}

describe('MIGRATE', () => {
  it('moves the keys: RESTORE with the remaining TTL, then the source keys are deleted', async () => {
    await t.call('SET', 'mg:a', '1');
    await t.call('SET', 'mg:b', '2', 'PX', 500000);
    expect(await t.call('MIGRATE', host, target.port, '', 0, 1000, 'KEYS', 'mg:a', 'mg:b', 'mg:none')).toBe('OK');
    const got = await target.received();
    expect(got[0]).toEqual(['SELECT', '0']);
    expect(got[1]).toEqual(['RESTORE', 'mg:a', '0']);
    expect(got[2][1]).toBe('mg:b');
    expect(Number(got[2][2])).toBeGreaterThan(400000);
    expect(await t.call('EXISTS', 'mg:a', 'mg:b')).toBe(0);
    // the deletion is propagated as one DEL
    await eventually(() => expect(aofText()).toContain('*3\r\n$3\r\nDEL\r\n$4\r\nmg:a\r\n$4\r\nmg:b\r\n'));
  });

  it('COPY keeps the source, REPLACE and AUTH2 are passed on, the cached connection keeps its db', async () => {
    await t.call('SET', 'mg:c', 'v');
    expect(await t.call('MIGRATE', host, target.port, 'mg:c', 0, 1000, 'COPY', 'REPLACE', 'AUTH2', 'u', 'p')).toBe('OK');
    expect(await target.received()).toEqual([['AUTH', 'u', 'p'], ['RESTORE', 'mg:c', '0', 'REPLACE']]);
    expect(await t.call('EXISTS', 'mg:c')).toBe(1);
  });

  it('a refused RESTORE: the first error is reported, the accepted keys still leave', async () => {
    await target.received(['mg:e2']);
    await t.call('MSET', 'mg:e1', '1', 'mg:e2', '2');
    expect(await err(t.call('MIGRATE', host, target.port, '', 0, 1000, 'KEYS', 'mg:e1', 'mg:e2'))).toBe(
      'ERR Target instance replied with error: ERR no mg:e2',
    );
    expect(await t.call('EXISTS', 'mg:e1')).toBe(0);
    expect(await t.call('EXISTS', 'mg:e2')).toBe(1);
    // after an error the connection's db is unknown: the next MIGRATE selects again
    await target.received([]);
    expect(await t.call('MIGRATE', host, target.port, 'mg:e2', 0, 1000, 'COPY')).toBe('OK');
    expect((await target.received())[0]).toEqual(['SELECT', '0']);
  });

  it('a deleted key fires del', async () => {
    const sub = await t.raw();
    await t.call('CONFIG', 'SET', 'notify-keyspace-events', 'Eg');
    await sub.send('SUBSCRIBE', '__keyevent@0__:del');
    await t.call('SET', 'mg:ev', 'v');
    expect(await t.call('MIGRATE', host, target.port, 'mg:ev', 0, 1000)).toBe('OK');
    expect(await sub.read()).toBe('*3\r\n$7\r\nmessage\r\n$18\r\n__keyevent@0__:del\r\n$5\r\nmg:ev\r\n');
    await t.call('CONFIG', 'SET', 'notify-keyspace-events', '');
  });

  it('NOKEY, IOERR and argument errors', async () => {
    expect(await t.call('MIGRATE', host, 1, 'mg:missing', 0, 100)).toBe('NOKEY');
    await t.call('SET', 'mg:k', 'v');
    expect(await err(t.call('MIGRATE', host, 1, 'mg:k', 0, 100))).toBe('IOERR error or timeout writing to target instance');
    expect(await t.call('EXISTS', 'mg:k')).toBe(1);
    expect(await err(t.call('MIGRATE', host, 1, 'mg:k', 0, 100, 'FOO'))).toBe(SYNTAX);
    expect(await err(t.call('MIGRATE', host, 1, 'mg:k', 'x', 100))).toBe(NOT_INT);
    expect(await err(t.call('MIGRATE', host, 1, 'mg:k', 0, 100, 'KEYS', 'mg:k'))).toBe(
      'ERR When using MIGRATE KEYS option, the key argument must be set to the empty string',
    );
  });
});

describe('RESTORE-ASKING', () => {
  it('is RESTORE', async () => {
    await t.call('SET', 'ra:src', 'hello');
    const payload = await t.redis.dumpBuffer('ra:src');
    expect(await t.call('RESTORE-ASKING', 'ra:dst', 0, payload)).toBe('OK');
    expect(await t.call('GET', 'ra:dst')).toBe('hello');
    expect(await err(t.call('RESTORE-ASKING', 'ra:dst', 0, payload))).toBe('BUSYKEY Target key name already exists.');
  });
});
