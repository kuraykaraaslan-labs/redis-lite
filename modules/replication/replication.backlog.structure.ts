/**
 * The replication backlog: a fixed-size ring of the last bytes of the replication stream, addressed by replication
 * offset, so a replica that reconnects can continue (PSYNC) from where it stopped.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * Offsets follow INFO replication: the stream's first byte has offset 1 and `master_repl_offset` is the offset of the
 * last byte written. The backlog holds the `histlen` bytes ending at `endOffset`, so its first byte is
 * `endOffset - histlen + 1` (`repl_backlog_first_byte_offset`).
 */
export class ReplicationBacklog {
  private buffer: Buffer;
  /** Next write position in the ring. */
  private idx = 0;
  /** Bytes held (at most the size). */
  histlen = 0;

  constructor(
    size: number,
    /** Offset of the last byte written (the master_repl_offset the backlog was created at). */
    public endOffset: number,
  ) {
    this.buffer = Buffer.alloc(Math.max(1, size));
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  get size(): number {
    return this.buffer.length;
  }

  /** repl_backlog_first_byte_offset. */
  get firstByteOffset(): number {
    return this.endOffset - this.histlen + 1;
  }

  /** Appends stream bytes. */
  append(data: Buffer): void {
    const size = this.buffer.length;
    this.endOffset += data.length;
    let src = data.length > size ? data.subarray(data.length - size) : data;
    while (src.length) {
      const n = Math.min(src.length, size - this.idx);
      src.copy(this.buffer, this.idx, 0, n);
      this.idx = (this.idx + n) % size;
      src = src.subarray(n);
    }
    this.histlen = Math.min(size, this.histlen + data.length);
  }

  /** True when the bytes from `offset` (the first byte a replica wants) up to the end are all held. */
  covers(offset: number): boolean {
    return offset >= this.firstByteOffset && offset <= this.endOffset + 1;
  }

  /** The bytes from `offset` to the end (call covers() first). */
  readFrom(offset: number): Buffer {
    const count = this.endOffset + 1 - offset;
    if (count <= 0) return Buffer.alloc(0);
    const size = this.buffer.length;
    const start = (this.idx - count + size * 2) % size;
    if (start + count <= size) return Buffer.from(this.buffer.subarray(start, start + count));
    return Buffer.concat([this.buffer.subarray(start), this.buffer.subarray(0, count - (size - start))]);
  }

  /** CONFIG SET repl-backlog-size: keeps the newest bytes that fit. */
  resize(size: number): void {
    if (size === this.buffer.length) return;
    const keep = this.readFrom(this.endOffset + 1 - Math.min(this.histlen, size));
    this.buffer = Buffer.alloc(Math.max(1, size));
    this.idx = 0;
    this.histlen = 0;
    const end = this.endOffset;
    this.endOffset = end - keep.length;
    this.append(keep);
  }
}
