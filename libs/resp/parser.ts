import { formatMessage } from '@/libs/message-format';

import { RespMessages } from './messages';

/** Redis protocol limits (networking.c / server.h). */
const PROTO_INLINE_MAX_SIZE = 64 * 1024;
const INT_MAX = 2147483647;
const DEFAULT_PROTO_MAX_BULK_LEN = 512 * 1024 * 1024;

/** Redis string2ll: optional '-', no '+', no leading zeros, no spaces, fits a signed 64-bit integer. */
function strictInteger(text: string): number | null {
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(text)) return null;
  const n = BigInt(text);
  if (n > 9223372036854775807n || n < -9223372036854775808n) return null;
  return Number(n);
}

/**
 * strictInteger() of the header bytes buf[start, end) without building a string: up to 15 characters (always a safe
 * integer) are read directly; longer ones go through strictInteger().
 */
function headerInteger(buf: Buffer, start: number, end: number): number | null {
  const len = end - start;
  if (len < 1) return null;
  if (len > 15) return strictInteger(buf.toString('latin1', start, end));
  let i = start;
  const negative = buf[i] === 0x2d; /* - */
  if (negative && ++i === end) return null;
  // '0' only on its own: no leading zeros, no "-0"
  if (buf[i] === 0x30) return !negative && i + 1 === end ? 0 : null;
  let n = 0;
  for (; i < end; i++) {
    const digit = buf[i] - 0x30;
    if (digit < 0 || digit > 9) return null;
    n = n * 10 + digit;
  }
  return negative ? -n : n;
}

const isSpace = (c: string | undefined): boolean =>
  c === ' ' ||
  c === '\n' ||
  c === '\r' ||
  c === '\t' ||
  c === '\v' ||
  c === '\f';
const isHex = (c: string | undefined): boolean =>
  c !== undefined && /^[0-9a-fA-F]$/.test(c);

export interface RespParserOptions {
  /**
   * proto-max-bulk-len, read once per parse() call: the commands of a chunk run only after the whole chunk is parsed, so
   * a CONFIG SET applies from the next chunk on either way. Default 512 MB.
   */
  maxBulkLen?: () => number;
}

/** Result of {@link RespParser.parse}: the commands parsed from the chunk, then the protocol error that stopped parsing (if any). */
export interface ParseResult {
  commands: string[][];
  /** Error text without the "ERR " prefix, e.g. "Protocol error: invalid bulk length". Once set, the connection must be closed. */
  error: string | null;
}

/**
 * Incremental request parser (Redis processMultibulkBuffer / processInlineBuffer): feed socket chunks, get complete commands
 * (argv arrays of binary strings). Never allocates ahead of the bytes actually received.
 */
export class RespParser {
  /** Unconsumed data starts at `pos`; `pending` holds chunks not yet merged (a large bulk arriving piece by piece). */
  private buffer: Buffer = Buffer.alloc(0);
  private pos = 0;
  private readonly pending: Buffer[] = [];
  private pendingSize = 0;
  /** Multibulk in progress: arguments still expected, those read so far, and the announced length of the next bulk (-1 = header not read). */
  private multibulkLen = 0;
  private argv: string[] = [];
  private bulkLen = -1;
  /** proto-max-bulk-len for the current parse() call (no command runs while a chunk is parsed); null = not read yet. */
  private maxBulk: number | null = null;
  /** Protocol error that stopped the parser; every later call reports it again. */
  private error: string | null = null;
  /** Set when feed() returned commands that preceded a protocol error: the error is in `lastError` and thrown by the next feed(). */
  lastError: string | null = null;

  constructor(private readonly options: RespParserOptions = {}) {}

  /**
   * Backward compatible API: returns the complete commands. A protocol error with no command before it in this chunk is thrown
   * at once; one that follows commands is stored in `lastError` (and thrown by the next call) so those commands are served first.
   */
  feed(chunk: Buffer): string[][] {
    if (this.error !== null && this.lastError === null)
      throw new Error(this.error);
    if (this.lastError !== null) {
      this.lastError = null;
      throw new Error(this.error ?? RespMessages.PROTOCOL_ERROR);
    }
    const { commands, error } = this.parse(chunk);
    if (error !== null) {
      if (!commands.length) throw new Error(error);
      this.lastError = error;
    }
    return commands;
  }

  /** Parses a chunk; never throws. After an error the parser is dead: later calls return no commands and the same error. */
  parse(chunk: Buffer): ParseResult {
    if (this.error !== null) return { commands: [], error: this.error };
    if (chunk.length) {
      this.pending.push(chunk);
      this.pendingSize += chunk.length;
    }
    const commands: string[][] = [];
    this.maxBulk = null;
    try {
      for (;;) {
        const parsed = this.parseOne();
        if (parsed === null) break;
        if (parsed.length) commands.push(parsed);
      }
    } catch (error) {
      this.error = (error as Error).message;
      this.buffer = Buffer.alloc(0);
      this.pos = 0;
      this.pending.length = 0;
      this.pendingSize = 0;
      return { commands, error: this.error };
    }
    return { commands, error: null };
  }

  private available(): number {
    return this.buffer.length - this.pos + this.pendingSize;
  }

  /** Merges pending chunks into `buffer` (dropping consumed bytes). */
  private consolidate(): void {
    if (!this.pendingSize) return;
    const rest =
      this.pos < this.buffer.length ? [this.buffer.subarray(this.pos)] : [];
    this.buffer =
      rest.length || this.pending.length > 1
        ? Buffer.concat([...rest, ...this.pending])
        : this.pending[0];
    this.pos = 0;
    this.pending.length = 0;
    this.pendingSize = 0;
  }

  /** Returns a command (possibly empty = nothing to run), or null when more bytes are needed. */
  private parseOne(): string[] | null {
    if (this.multibulkLen === 0) {
      if (!this.available()) return null;
      this.consolidate();
      if (this.buffer[this.pos] !== 0x2a /* * */) return this.parseInline();
      const ll = this.readHeaderInteger(RespMessages.PROTOCOL_MBULK_TOO_BIG, false);
      if (ll === undefined) return null;
      if (ll === null || ll > INT_MAX)
        throw new Error(RespMessages.PROTOCOL_INVALID_MBULK);
      if (ll <= 0) return [];
      this.multibulkLen = ll;
      this.argv = [];
    }
    while (this.multibulkLen > 0) {
      if (this.bulkLen < 0) {
        this.consolidate();
        const ll = this.readHeaderInteger(RespMessages.PROTOCOL_BULK_TOO_BIG, true);
        if (ll === undefined) return null;
        this.maxBulk ??= this.options.maxBulkLen?.() ?? DEFAULT_PROTO_MAX_BULK_LEN;
        if (ll === null || ll < 0 || ll > this.maxBulk)
          throw new Error(RespMessages.PROTOCOL_INVALID_BULK);
        this.bulkLen = ll;
      }
      if (this.available() < this.bulkLen + 2) return null;
      this.consolidate();
      this.argv.push(
        this.buffer.toString('latin1', this.pos, this.pos + this.bulkLen),
      );
      this.pos += this.bulkLen + 2;
      this.bulkLen = -1;
      this.multibulkLen--;
    }
    const argv = this.argv;
    this.argv = [];
    return argv;
  }

  /**
   * Reads a `\r`-terminated header line (Redis looks for '\r' and skips two bytes) and returns the integer after its type
   * byte (null when it is not a strict integer). Returns undefined when incomplete; throws `tooBig` when 64 KB arrived
   * without a line end. With `bulk`, the line must start with '$'.
   */
  private readHeaderInteger(tooBig: string, bulk: boolean): number | null | undefined {
    const buf = this.buffer;
    const cr = buf.indexOf(0x0d, this.pos);
    if (cr < 0) {
      if (buf.length - this.pos > PROTO_INLINE_MAX_SIZE)
        throw new Error(tooBig);
      return undefined;
    }
    if (cr + 2 > buf.length) return undefined;
    if (bulk && buf[this.pos] !== 0x24 /* $ */)
      throw new Error(
        formatMessage(RespMessages.PROTOCOL_EXPECTED_DOLLAR, { got: String.fromCharCode(buf[this.pos]) }),
      );
    const value = headerInteger(buf, this.pos + 1, cr);
    this.pos = cr + 2;
    return value;
  }

  /** Inline commands (`PING\r\n`), as typed into telnet/nc. */
  private parseInline(): string[] | null {
    const buf = this.buffer;
    const nl = buf.indexOf(0x0a, this.pos);
    if (nl < 0) {
      if (buf.length - this.pos > PROTO_INLINE_MAX_SIZE)
        throw new Error(RespMessages.PROTOCOL_INLINE_TOO_BIG);
      return null;
    }
    const end = nl > this.pos && buf[nl - 1] === 0x0d ? nl - 1 : nl;
    const line = buf.toString('latin1', this.pos, end);
    this.pos = nl + 1;
    const argv = RespParser.splitArgs(line);
    if (argv === null)
      throw new Error(RespMessages.PROTOCOL_UNBALANCED_QUOTES);
    return argv;
  }

  /**
   * Redis sdssplitargs: whitespace-separated arguments; "double quotes" with \n \r \t \b \a \\ \" \xHH escapes, 'single quotes'
   * with only \' escaped. A closing quote must be followed by whitespace or the end. Returns null on unbalanced quotes.
   */
  static splitArgs(line: string): string[] | null {
    const out: string[] = [];
    // sdssplitargs works on a C string: a NUL byte ends the input.
    const nul = line.indexOf('\0');
    const s = nul < 0 ? line : line.slice(0, nul);
    let p = 0;
    for (;;) {
      while (p < s.length && isSpace(s[p])) p++;
      if (p >= s.length) return out;
      let inq = false;
      let insq = false;
      let done = false;
      let current = '';
      while (!done) {
        const c = s[p];
        if (inq) {
          if (c === undefined) return null;
          if (
            c === '\\' &&
            s[p + 1] === 'x' &&
            isHex(s[p + 2]) &&
            isHex(s[p + 3])
          ) {
            current += String.fromCharCode(
              Number.parseInt(s.slice(p + 2, p + 4), 16),
            );
            p += 3;
          } else if (c === '\\' && p + 1 < s.length) {
            p++;
            const e = s[p];
            current +=
              e === 'n'
                ? '\n'
                : e === 'r'
                  ? '\r'
                  : e === 't'
                    ? '\t'
                    : e === 'b'
                      ? '\b'
                      : e === 'a'
                        ? '\x07'
                        : e;
          } else if (c === '"') {
            if (p + 1 < s.length && !isSpace(s[p + 1])) return null;
            done = true;
          } else current += c;
        } else if (insq) {
          if (c === undefined) return null;
          if (c === '\\' && s[p + 1] === "'") {
            p++;
            current += "'";
          } else if (c === "'") {
            if (p + 1 < s.length && !isSpace(s[p + 1])) return null;
            done = true;
          } else current += c;
        } else if (
          c === undefined ||
          c === ' ' ||
          c === '\n' ||
          c === '\r' ||
          c === '\t'
        ) {
          done = true;
        } else if (c === '"') inq = true;
        else if (c === "'") insq = true;
        else current += c;
        if (p < s.length) p++;
      }
      out.push(current);
    }
  }
}
