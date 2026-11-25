/**
 * RESP2 wire protocol: request parser and reply encoder.
 *
 * Every Redis string is kept as a "binary string": a JS string where each char is one byte (latin1). That keeps keys and values
 * byte-exact (msgpack payloads, UTF-8 text, anything) while still letting us use them as Map keys.
 */

export class Status {
  constructor(readonly value: string) {}
}

export class RespError {
  constructor(readonly message: string) {}
}

/** RESP3 map (`%`); RESP2 sends it as a flat array of key, value, key, value… */
export class RespMap {
  /** `nestedInResp2`: RESP2 gets [[k, v], …] instead of a flat array (XREAD, XREADGROUP). */
  constructor(
    readonly entries: Array<[Reply, Reply]>,
    readonly nestedInResp2 = false,
  ) {}

  static from(flat: Reply[]): RespMap {
    const entries: Array<[Reply, Reply]> = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      entries.push([flat[i], flat[i + 1]]);
    return new RespMap(entries);
  }
}

/** RESP3 set (`~`); RESP2 sends it as an array. */
export class RespSet {
  constructor(readonly items: Reply[]) {}
}

/** RESP3 double (`,`); RESP2 sends it as a bulk string. */
export class RespDouble {
  /** `text` overrides the default formatting (GEOPOS prints 17 decimals). */
  constructor(
    readonly value: number,
    readonly text?: string,
  ) {}
}

/** RESP3 out-of-band push (`>`): pub/sub messages, invalidations. RESP2 sends it as an array. */
export class RespPush {
  constructor(readonly items: Reply[]) {}
}

/** RESP3 verbatim string (`=`, e.g. INFO); RESP2 sends a bulk string. */
export class RespVerbatim {
  constructor(
    readonly text: string,
    readonly format = "txt",
  ) {}
}

/** RESP3 boolean (`#`); RESP2 sends integer 1 / 0. */
export class RespBool {
  constructor(readonly value: boolean) {}
}

/** RESP3 big number (`(`); RESP2 sends a bulk string. */
export class RespBigNumber {
  constructor(readonly value: bigint) {}
}

/** A list of pairs: RESP2 flattens it (a, b, a, b…), RESP3 nests it ([a, b], [a, b]…). ZRANGE WITHSCORES, HRANDFIELD WITHVALUES. */
export class RespPairs {
  constructor(readonly pairs: Array<[Reply, Reply]>) {}
}

/** RESP2 null array (`*-1`): the timeout reply of blocking commands and an aborted EXEC. RESP3 sends `_`. */
export const NULL_ARRAY = Symbol("NULL_ARRAY");

export type Reply =
  | string
  | number
  | bigint
  | null
  | Status
  | RespError
  | RespMap
  | RespSet
  | RespDouble
  | RespPush
  | RespVerbatim
  | RespBool
  | RespBigNumber
  | RespPairs
  | typeof NULL_ARRAY
  | Reply[];

export const OK = new Status("OK");
export const QUEUED = new Status("QUEUED");
export const PONG = new Status("PONG");

const CRLF = "\r\n";

export type Protocol = 2 | 3;

/** Doubles as Redis prints them: shortest round-trip form, inf / -inf / nan. */
export function formatDouble(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Object.is(n, -0)) return "-0";
  return String(n);
}

export function encode(reply: Reply, proto: Protocol = 2): Buffer {
  const parts: string[] = [];
  write(reply, parts, proto);
  return Buffer.from(parts.join(""), "latin1");
}

function write(reply: Reply, out: string[], proto: Protocol): void {
  if (reply === null) {
    out.push(proto === 3 ? "_\r\n" : "$-1\r\n");
  } else if (reply === NULL_ARRAY) {
    out.push(proto === 3 ? "_\r\n" : "*-1\r\n");
  } else if (typeof reply === "string") {
    out.push("$", String(reply.length), CRLF, reply, CRLF);
  } else if (typeof reply === "number") {
    out.push(":", String(Math.trunc(reply)), CRLF);
  } else if (typeof reply === "bigint") {
    out.push(":", reply.toString(), CRLF);
  } else if (reply instanceof Status) {
    out.push("+", reply.value, CRLF);
  } else if (reply instanceof RespError) {
    out.push("-", reply.message.replace(/[\r\n]+/g, " "), CRLF);
  } else if (reply instanceof RespMap && reply.nestedInResp2 && proto === 2) {
    write(
      reply.entries.map(([k, v]) => [k, v]),
      out,
      proto,
    );
  } else if (reply instanceof RespMap) {
    out.push(
      proto === 3 ? "%" : "*",
      String(proto === 3 ? reply.entries.length : reply.entries.length * 2),
      CRLF,
    );
    for (const [k, v] of reply.entries) {
      write(k, out, proto);
      write(v, out, proto);
    }
  } else if (reply instanceof RespSet) {
    out.push(proto === 3 ? "~" : "*", String(reply.items.length), CRLF);
    for (const item of reply.items) write(item, out, proto);
  } else if (reply instanceof RespPush) {
    out.push(proto === 3 ? ">" : "*", String(reply.items.length), CRLF);
    for (const item of reply.items) write(item, out, proto);
  } else if (reply instanceof RespDouble) {
    const text = reply.text ?? formatDouble(reply.value);
    if (proto === 3) out.push(",", text, CRLF);
    else out.push("$", String(text.length), CRLF, text, CRLF);
  } else if (reply instanceof RespVerbatim) {
    if (proto === 3) {
      const body = `${reply.format}:${reply.text}`;
      out.push("=", String(body.length), CRLF, body, CRLF);
    } else out.push("$", String(reply.text.length), CRLF, reply.text, CRLF);
  } else if (reply instanceof RespBool) {
    out.push(
      proto === 3
        ? reply.value
          ? "#t\r\n"
          : "#f\r\n"
        : reply.value
          ? ":1\r\n"
          : ":0\r\n",
    );
  } else if (reply instanceof RespPairs) {
    if (proto === 3) {
      out.push("*", String(reply.pairs.length), CRLF);
      for (const [a, b] of reply.pairs) {
        out.push("*2\r\n");
        write(a, out, proto);
        write(b, out, proto);
      }
    } else {
      out.push("*", String(reply.pairs.length * 2), CRLF);
      for (const [a, b] of reply.pairs) {
        write(a, out, proto);
        write(b, out, proto);
      }
    }
  } else if (reply instanceof RespBigNumber) {
    const text = reply.value.toString();
    if (proto === 3) out.push("(", text, CRLF);
    else out.push("$", String(text.length), CRLF, text, CRLF);
  } else {
    out.push("*", String(reply.length), CRLF);
    for (const item of reply) write(item, out, proto);
  }
}

/** Converts RESP3-typed replies to their RESP2 shape (what Lua scripts see by default). */
export function toResp2(reply: Reply): Reply {
  if (reply instanceof RespMap && reply.nestedInResp2)
    return reply.entries.map(([k, v]) => [toResp2(k), toResp2(v)]);
  if (reply instanceof RespMap)
    return reply.entries.flatMap(([k, v]) => [toResp2(k), toResp2(v)]);
  if (reply instanceof RespSet || reply instanceof RespPush)
    return reply.items.map(toResp2);
  if (reply instanceof RespDouble)
    return reply.text ?? formatDouble(reply.value);
  if (reply instanceof RespVerbatim) return reply.text;
  if (reply instanceof RespBool) return reply.value ? 1 : 0;
  if (reply instanceof RespBigNumber) return reply.value.toString();
  if (reply instanceof RespPairs)
    return reply.pairs.flatMap(([a, b]) => [toResp2(a), toResp2(b)]);
  if (Array.isArray(reply)) return reply.map(toResp2);
  return reply;
}

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

const isSpace = (c: string | undefined): boolean =>
  c === " " ||
  c === "\n" ||
  c === "\r" ||
  c === "\t" ||
  c === "\v" ||
  c === "\f";
const isHex = (c: string | undefined): boolean =>
  c !== undefined && /^[0-9a-fA-F]$/.test(c);

export interface RespParserOptions {
  /** proto-max-bulk-len, read on every bulk header so CONFIG SET applies at once. Default 512 MB. */
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
      throw new Error(this.error ?? "Protocol error");
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
      const header = this.readLine(
        "Protocol error: too big mbulk count string",
      );
      if (header === null) return null;
      const ll = strictInteger(header.slice(1));
      if (ll === null || ll > INT_MAX)
        throw new Error("Protocol error: invalid multibulk length");
      if (ll <= 0) return [];
      this.multibulkLen = ll;
      this.argv = [];
    }
    while (this.multibulkLen > 0) {
      if (this.bulkLen < 0) {
        this.consolidate();
        const line = this.readLine(
          "Protocol error: too big bulk count string",
          true,
        );
        if (line === null) return null;
        const ll = strictInteger(line.slice(1));
        const max = this.options.maxBulkLen?.() ?? DEFAULT_PROTO_MAX_BULK_LEN;
        if (ll === null || ll < 0 || ll > max)
          throw new Error("Protocol error: invalid bulk length");
        this.bulkLen = ll;
      }
      if (this.available() < this.bulkLen + 2) return null;
      this.consolidate();
      this.argv.push(
        this.buffer.toString("latin1", this.pos, this.pos + this.bulkLen),
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
   * Reads a `\r`-terminated header line (Redis looks for '\r' and skips two bytes). Returns null when incomplete; throws `tooBig`
   * when 64 KB arrived without a line end. With `bulk`, the line must start with '$'.
   */
  private readLine(tooBig: string, bulk = false): string | null {
    const buf = this.buffer;
    const cr = buf.indexOf(0x0d, this.pos);
    if (cr < 0) {
      if (buf.length - this.pos > PROTO_INLINE_MAX_SIZE)
        throw new Error(tooBig);
      return null;
    }
    if (cr + 2 > buf.length) return null;
    if (bulk && buf[this.pos] !== 0x24 /* $ */)
      throw new Error(
        `Protocol error: expected '$', got '${String.fromCharCode(buf[this.pos])}'`,
      );
    const line = buf.toString("latin1", this.pos, cr);
    this.pos = cr + 2;
    return line;
  }

  /** Inline commands (`PING\r\n`), as typed into telnet/nc. */
  private parseInline(): string[] | null {
    const buf = this.buffer;
    const nl = buf.indexOf(0x0a, this.pos);
    if (nl < 0) {
      if (buf.length - this.pos > PROTO_INLINE_MAX_SIZE)
        throw new Error("Protocol error: too big inline request");
      return null;
    }
    const end = nl > this.pos && buf[nl - 1] === 0x0d ? nl - 1 : nl;
    const line = buf.toString("latin1", this.pos, end);
    this.pos = nl + 1;
    const argv = RespParser.splitArgs(line);
    if (argv === null)
      throw new Error("Protocol error: unbalanced quotes in request");
    return argv;
  }

  /**
   * Redis sdssplitargs: whitespace-separated arguments; "double quotes" with \n \r \t \b \a \\ \" \xHH escapes, 'single quotes'
   * with only \' escaped. A closing quote must be followed by whitespace or the end. Returns null on unbalanced quotes.
   */
  static splitArgs(line: string): string[] | null {
    const out: string[] = [];
    // sdssplitargs works on a C string: a NUL byte ends the input.
    const nul = line.indexOf("\0");
    const s = nul < 0 ? line : line.slice(0, nul);
    let p = 0;
    for (;;) {
      while (p < s.length && isSpace(s[p])) p++;
      if (p >= s.length) return out;
      let inq = false;
      let insq = false;
      let done = false;
      let current = "";
      while (!done) {
        const c = s[p];
        if (inq) {
          if (c === undefined) return null;
          if (
            c === "\\" &&
            s[p + 1] === "x" &&
            isHex(s[p + 2]) &&
            isHex(s[p + 3])
          ) {
            current += String.fromCharCode(
              Number.parseInt(s.slice(p + 2, p + 4), 16),
            );
            p += 3;
          } else if (c === "\\" && p + 1 < s.length) {
            p++;
            const e = s[p];
            current +=
              e === "n"
                ? "\n"
                : e === "r"
                  ? "\r"
                  : e === "t"
                    ? "\t"
                    : e === "b"
                      ? "\b"
                      : e === "a"
                        ? "\x07"
                        : e;
          } else if (c === '"') {
            if (p + 1 < s.length && !isSpace(s[p + 1])) return null;
            done = true;
          } else current += c;
        } else if (insq) {
          if (c === undefined) return null;
          if (c === "\\" && s[p + 1] === "'") {
            p++;
            current += "'";
          } else if (c === "'") {
            if (p + 1 < s.length && !isSpace(s[p + 1])) return null;
            done = true;
          } else current += c;
        } else if (
          c === undefined ||
          c === " " ||
          c === "\n" ||
          c === "\r" ||
          c === "\t"
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
