/**
 * Replica side: an incremental reader of what the master sends on the replication link, in the three shapes the
 * documented protocol uses one after the other: reply lines during the handshake (`+PONG`, `+FULLRESYNC <id> <off>`),
 * the RDB payload (`$<len>\r\n<bytes>`, or the diskless `$EOF:<40-byte mark>\r\n<bytes><mark>`, possibly preceded by
 * `\n` keepalives), then the command stream (RESP arrays), each command with the exact bytes it took, which is what
 * the replication offset counts.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * A stateful parser, one per link (it holds the bytes received but not consumed yet).
 */
import type { StreamCommand } from './replication.types';

/** The payload being received. */
type Payload = { remaining: number } | { mark: Buffer; tail: Buffer };

export class ReplicationStreamReader {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  private static readonly EOF_MARK_LEN = 40;
  /** A header line longer than this without CRLF is a protocol error. */
  private static readonly MAX_LINE = 64 * 1024;

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────

  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  private payload: Payload | null = null;
  private chunks: Buffer[] = [];
  /** Bytes of the current payload received so far / announced (-1: EOF-marker form, size unknown). */
  received = 0;
  total = 0;

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private get available(): number {
    return this.buf.length - this.pos;
  }

  private take(n: number): Buffer {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** A CRLF-terminated line at `from`, or null when incomplete. Throws past MAX_LINE. */
  private lineAt(from: number): { text: string; next: number } | null {
    const cr = this.buf.indexOf('\r\n', from, 'latin1');
    if (cr < 0) {
      if (this.buf.length - from > ReplicationStreamReader.MAX_LINE) throw new Error('Protocol error: too big header line');
      return null;
    }
    return { text: this.buf.toString('latin1', from, cr), next: cr + 2 };
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  push(chunk: Buffer): void {
    if (this.pos === this.buf.length) {
      this.buf = chunk;
      this.pos = 0;
    } else {
      this.buf = Buffer.concat([this.buf.subarray(this.pos), chunk]);
      this.pos = 0;
    }
  }

  /** The bytes received but not consumed (handed to whoever reads the link next). */
  rest(): Buffer {
    return this.take(this.available);
  }

  /** One reply line of the handshake (without CRLF), or null when incomplete. Keepalive newlines are skipped. */
  readLine(): string | null {
    while (this.available && this.buf[this.pos] === 0x0a) this.pos++;
    const line = this.lineAt(this.pos);
    if (!line) return null;
    this.pos = line.next;
    return line.text;
  }

  /** True once the payload header was read (`$<len>` or `$EOF:<mark>`); false while more bytes are needed. */
  beginPayload(): boolean {
    if (this.payload) return true;
    while (this.available && (this.buf[this.pos] === 0x0a || this.buf[this.pos] === 0x0d)) this.pos++;
    const line = this.lineAt(this.pos);
    if (!line) return false;
    if (line.text[0] !== '$') throw new Error(`Bad protocol from MASTER, the first byte is not '$' (we received '${line.text.slice(0, 64)}')`);
    this.pos = line.next;
    this.chunks = [];
    this.received = 0;
    if (line.text.startsWith('$EOF:')) {
      const mark = Buffer.from(line.text.slice(5), 'latin1');
      if (mark.length !== ReplicationStreamReader.EOF_MARK_LEN) throw new Error('Bad EOF mark from MASTER');
      this.payload = { mark, tail: Buffer.alloc(0) };
      this.total = -1;
    } else {
      const len = Number(line.text.slice(1));
      if (!Number.isSafeInteger(len) || len < 0) throw new Error('Bad payload length from MASTER');
      this.payload = { remaining: len };
      this.total = len;
    }
    return true;
  }

  /** Consumes payload bytes; the whole payload once it is complete (what follows stays for readCommand), else null. */
  pumpPayload(): Buffer | null {
    const p = this.payload;
    if (!p) return null;
    if ('remaining' in p) {
      const n = Math.min(p.remaining, this.available);
      if (n) {
        this.chunks.push(Buffer.from(this.take(n)));
        p.remaining -= n;
        this.received += n;
      }
      if (p.remaining > 0) return null;
      this.payload = null;
      return Buffer.concat(this.chunks.splice(0));
    }
    // EOF form: look for the mark across the previous tail and the new bytes
    const data = this.take(this.available);
    if (!data.length) return null;
    const window = Buffer.concat([p.tail, data]);
    const at = window.indexOf(p.mark);
    if (at < 0) {
      const keep = Math.min(window.length, p.mark.length - 1);
      const flushed = window.subarray(0, window.length - keep);
      if (flushed.length) this.chunks.push(Buffer.from(flushed));
      p.tail = Buffer.from(window.subarray(window.length - keep));
      this.received += data.length;
      return null;
    }
    this.chunks.push(Buffer.from(window.subarray(0, at)));
    const after = window.subarray(at + p.mark.length);
    this.received += data.length - after.length;
    this.payload = null;
    this.buf = Buffer.from(after);
    this.pos = 0;
    return Buffer.concat(this.chunks.splice(0));
  }

  /** The next complete command of the stream (RESP array of bulk strings), or null when incomplete. */
  readCommand(): StreamCommand | null {
    const start = this.pos;
    if (!this.available) return null;
    if (this.buf[start] !== 0x2a /* * */) {
      // a bare newline (keepalive) counts as a byte of the stream and runs nothing
      if (this.buf[start] === 0x0a) {
        this.pos++;
        return { argv: [], bytes: this.buf.subarray(start, start + 1) };
      }
      throw new Error(`Protocol error: expected '*' from MASTER, got '${String.fromCharCode(this.buf[start])}'`);
    }
    const header = this.lineAt(start);
    if (!header) return null;
    const count = Number(header.text.slice(1));
    if (!Number.isSafeInteger(count)) throw new Error('Protocol error: invalid multibulk length');
    let at = header.next;
    const argv: string[] = [];
    for (let i = 0; i < count; i++) {
      const line = this.lineAt(at);
      if (!line) return null;
      if (line.text[0] !== '$') throw new Error("Protocol error: expected '$' from MASTER");
      const len = Number(line.text.slice(1));
      if (!Number.isSafeInteger(len) || len < 0) throw new Error('Protocol error: invalid bulk length');
      if (this.buf.length < line.next + len + 2) return null;
      argv.push(this.buf.toString('latin1', line.next, line.next + len));
      at = line.next + len + 2;
    }
    this.pos = at;
    return { argv, bytes: this.buf.subarray(start, at) };
  }
}
