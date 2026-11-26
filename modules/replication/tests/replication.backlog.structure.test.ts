/**
 * The replication backlog ring (replication.backlog.structure): offsets as INFO replication reports them, wrap-around,
 * coverage of a PSYNC offset and resizing.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
import { describe, expect, it } from 'vitest';

import { ReplicationBacklog } from '@/modules/replication/replication.backlog.structure';

const bytes = (s: string): Buffer => Buffer.from(s, 'latin1');

describe('ReplicationBacklog', () => {
  it('addresses bytes by replication offset (the first byte is offset 1)', () => {
    const b = new ReplicationBacklog(8, 0);
    expect(b.firstByteOffset).toBe(1);
    b.append(bytes('abc'));
    expect(b.endOffset).toBe(3);
    expect(b.histlen).toBe(3);
    expect(b.firstByteOffset).toBe(1);
    expect(b.covers(1)).toBe(true);
    expect(b.covers(4)).toBe(true); // nothing missing: an empty continuation
    expect(b.covers(5)).toBe(false);
    expect(b.readFrom(2).toString('latin1')).toBe('bc');
    expect(b.readFrom(4).length).toBe(0);
  });

  it('keeps only the newest `size` bytes when it wraps', () => {
    const b = new ReplicationBacklog(8, 100);
    b.append(bytes('0123456'));
    b.append(bytes('789AB'));
    expect(b.endOffset).toBe(112);
    expect(b.histlen).toBe(8);
    expect(b.firstByteOffset).toBe(105);
    expect(b.covers(104)).toBe(false);
    expect(b.readFrom(105).toString('latin1')).toBe('456789AB');
    expect(b.readFrom(111).toString('latin1')).toBe('AB');
    b.append(bytes('x'.repeat(20) + 'tail'));
    expect(b.readFrom(b.firstByteOffset).toString('latin1')).toBe('xxxxtail');
  });

  it('resizes keeping the newest bytes', () => {
    const b = new ReplicationBacklog(8, 0);
    b.append(bytes('abcdefgh'));
    b.resize(4);
    expect(b.size).toBe(4);
    expect(b.endOffset).toBe(8);
    expect(b.readFrom(b.firstByteOffset).toString('latin1')).toBe('efgh');
    b.resize(16);
    b.append(bytes('ij'));
    expect(b.readFrom(5).toString('latin1')).toBe('efghij');
  });
});
