/**
 * The replica's reader of the replication link (replication.stream): handshake lines, the RDB payload in both
 * documented forms (`$<len>` and the diskless `$EOF:<mark>`) split at any byte, and stream commands with their exact
 * byte counts.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { ReplicationStreamReader } from '@/modules/replication/replication.stream';

const b = (s: string): Buffer => Buffer.from(s, 'latin1');

/** Feeds `data` one byte at a time, calling `step` after each byte. */
function trickle(reader: ReplicationStreamReader, data: string, step: () => void): void {
  for (const ch of data) {
    reader.push(b(ch));
    step();
  }
}

describe('ReplicationStreamReader', () => {
  it('reads handshake lines, skipping keepalive newlines', () => {
    const r = new ReplicationStreamReader();
    r.push(b('+PONG\r\n\n\n+FULLRESYNC 0123 42\r\n'));
    expect(r.readLine()).toBe('+PONG');
    expect(r.readLine()).toBe('+FULLRESYNC 0123 42');
    expect(r.readLine()).toBeNull();
  });

  it('reads a $<len> payload followed by the stream, whatever the chunking', () => {
    const r = new ReplicationStreamReader();
    const wire = '\n\n$5\r\nREDIS*1\r\n$4\r\nPING\r\n';
    const got: { payload: Buffer | null } = { payload: null };
    const cmds: string[][] = [];
    trickle(r, wire, () => {
      if (!got.payload) {
        if (r.beginPayload()) got.payload = r.pumpPayload();
        return;
      }
      const c = r.readCommand();
      if (c) cmds.push(c.argv);
    });
    expect(got.payload?.toString('latin1')).toBe('REDIS');
    expect(cmds).toEqual([['PING']]);
  });

  it('reads a diskless $EOF:<mark> payload split anywhere', () => {
    const mark = 'a'.repeat(40);
    const body = 'REDIS0012' + 'x'.repeat(100);
    const r = new ReplicationStreamReader();
    const got: { payload: Buffer | null } = { payload: null };
    trickle(r, `$EOF:${mark}\r\n${body}${mark}*1\r\n$4\r\nPING\r\n`, () => {
      if (!got.payload && r.beginPayload()) got.payload = r.pumpPayload();
    });
    expect(got.payload?.toString('latin1')).toBe(body);
    const c = r.readCommand();
    expect(c?.argv).toEqual(['PING']);
    expect(c?.bytes.length).toBe(14);
  });

  it('counts the exact bytes of each command (the replication offset)', () => {
    const r = new ReplicationStreamReader();
    const set = '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\na\rb\r\n';
    r.push(b(`${set}*2\r\n$6\r\nSELECT\r\n$1\r\n1`));
    const c = r.readCommand();
    expect(c?.argv).toEqual(['SET', 'k', 'a\rb']);
    expect(c?.bytes.toString('latin1')).toBe(set);
    expect(c?.bytes.length).toBe(29);
    expect(r.readCommand()).toBeNull();
    r.push(b('\r\n'));
    expect(r.readCommand()?.argv).toEqual(['SELECT', '1']);
  });

  it('rejects what is not the documented protocol', () => {
    const r = new ReplicationStreamReader();
    r.push(b('+OK\r\n'));
    expect(() => r.beginPayload()).toThrow(/first byte is not '\$'/);
    const s = new ReplicationStreamReader();
    s.push(b('GET k\r\n'));
    expect(() => s.readCommand()).toThrow(/expected '\*'/);
  });
});
