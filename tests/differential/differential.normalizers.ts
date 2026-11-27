import { isAggregate, parseResp, payload, serialize, withPayload } from './differential.resp';
import type { RespNode } from './differential.resp';

/**
 * Normalisers: applied identically to the oracle's and redis-lite's reply of one step before the bytes are compared.
 * Each one exists only for a part of a reply that Redis itself does not define (randomness, clocks, ids, memory
 * accounting, hash-table iteration order); everything else is compared byte for byte.
 */
export type Normalizer = (reply: string) => string;

function mapTree(reply: string, fn: (node: RespNode) => RespNode): string {
  if (reply.startsWith('<')) return reply; // TIMEOUT / CLOSED placeholders
  return serialize(fn(parseResp(reply).node));
}

/**
 * Sorts the elements of the top-level aggregate (map / attribute: by key, keeping pairs). Why: Redis returns
 * hashtable-encoded sets and hashes (SMEMBERS, HGETALL, HKEYS, SUNION, KEYS…) in hash-table iteration order, which
 * depends on its hash seed and table size, not on anything a client may rely on.
 */
export const sorted: Normalizer = (reply) =>
  mapTree(reply, (node) => {
    if (!isAggregate(node)) return node;
    if (node.type === '%' || node.type === '|') {
      const pairs: RespNode[][] = [];
      for (let i = 0; i < node.children.length; i += 2) pairs.push([node.children[i], node.children[i + 1]]);
      pairs.sort((a, b) => cmp(a[0].raw, b[0].raw));
      return { ...node, children: pairs.flat() };
    }
    return { ...node, children: [...node.children].sort((a, b) => cmp(a.raw, b.raw)) };
  });

/** Like `sorted`, for a flat RESP2 array of field/value pairs (HGETALL, ZRANGE … WITHSCORES in RESP2). */
export const sortedPairs: Normalizer = (reply) =>
  mapTree(reply, (node) => {
    if (node.type !== '*' || node.children.length % 2 !== 0) return node;
    const pairs: RespNode[][] = [];
    for (let i = 0; i < node.children.length; i += 2) pairs.push([node.children[i], node.children[i + 1]]);
    pairs.sort((a, b) => cmp(a[0].raw, b[0].raw));
    return { ...node, children: pairs.flat() };
  });

/** Sorts every aggregate at every depth (e.g. a set of sets from SINTERCARD-like nested replies, GEO members). */
export const sortedDeep: Normalizer = (reply) =>
  mapTree(reply, function deep(node: RespNode): RespNode {
    if (!isAggregate(node)) return node;
    const children = node.children.map(deep);
    return parseResp(sorted(serialize({ ...node, children }))).node;
  });

/**
 * Keeps the shape of a reply and drops leaf contents: bulk strings become `$?`, verbatim strings `=?`, integers `:?`,
 * doubles `,?`. Why: SPOP / SRANDMEMBER / RANDOMKEY / HRANDFIELD / ZRANDMEMBER pick members at random; only the reply
 * type and the number of elements are defined. (A RESP3 verbatim string is the RESP2 bulk string of the same reply, so
 * it is blanked the same way: MEMORY MALLOC-STATS differs in length between two runs of the same oracle.)
 */
export const shape: Normalizer = (reply) =>
  mapTree(reply, function blank(node: RespNode): RespNode {
    if (isAggregate(node)) return { ...node, children: node.children.map(blank) };
    if (node.type === '$' && Number(node.head) >= 0) return { ...node, raw: '$?\r\n' };
    if (node.type === '=') return { ...node, raw: '=?\r\n' };
    if (node.type === ':' || node.type === ',') return { ...node, raw: `${node.type}?\r\n` };
    return node;
  });

/**
 * Masks the value of an integer / double / bulk-number reply (and every number inside an aggregate). Why: the value is
 * a clock (TIME, LASTSAVE, OBJECT IDLETIME), a counter of the process (client ids) or memory accounting (MEMORY USAGE),
 * which differs between two servers by construction. The reply type is still compared.
 */
export const anyNumber: Normalizer = (reply) =>
  mapTree(reply, function mask(node: RespNode): RespNode {
    if (isAggregate(node)) return { ...node, children: node.children.map(mask) };
    if (node.type === ':' || node.type === ',') return { ...node, raw: `${node.type}N\r\n` };
    if ((node.type === '$' || node.type === '=') && /^-?\d+(\.\d+)?$/.test(payload(node))) return withPayload(node, 'N');
    return node;
  });

/** Applies `fn` to the text of every bulk / verbatim / simple-string leaf. */
export function text(fn: (s: string) => string): Normalizer {
  return (reply) =>
    mapTree(reply, function walk(node: RespNode): RespNode {
      if (isAggregate(node)) return { ...node, children: node.children.map(walk) };
      if (node.type === '$' || node.type === '=' || node.type === '+' || node.type === '-') {
        if (node.type === '$' && Number(node.head) < 0) return node;
        return withPayload(node, fn(payload(node)));
      }
      return node;
    });
}

/** Replaces the value of `name=<value>` / `name:<value>` fields with `name=N`. */
function maskFields(names: string[], sep: '=' | ':'): (s: string) => string {
  const re = new RegExp(`(^|[\\s,])(${names.join('|')})${sep}[^\\s,]*`, 'g');
  return (s) => s.replace(re, `$1$2${sep}N`);
}

/**
 * CLIENT LIST / CLIENT INFO: masks ids, addresses, fds, ages and per-connection memory figures. Why: they depend on the
 * process (connection counter, ephemeral port) and its allocator, never on the command semantics.
 */
export const clientInfo: Normalizer = text(
  maskFields(
    ['id', 'addr', 'laddr', 'fd', 'age', 'idle', 'qbuf', 'qbuf-free', 'argv-mem', 'multi-mem', 'obl', 'oll', 'omem',
      'tot-mem', 'rbs', 'rbp', 'events', 'redir', 'ssub', 'io-thread', 'tot-net-in', 'tot-net-out', 'tot-cmds'],
    '=',
  ),
);

/**
 * DEBUG OBJECT: masks the object address, LRU clock and idle seconds. Why: a pointer value and clocks; the encoding,
 * refcount and serialized length are compared.
 */
export const debugObject: Normalizer = text((s) =>
  s.replace(/Value at:0x[0-9a-f]+/, 'Value at:ADDR').replace(/ lru:\d+/, ' lru:N').replace(/ lru_seconds_idle:\d+/, ' lru_seconds_idle:N'),
);

/**
 * Masks digits inside error texts that carry a process-specific number (e.g. `-ERR ... client id 17`). Why: client
 * ids and ports differ by construction.
 */
export const digits: Normalizer = text((s) => s.replace(/\d+/g, 'N'));

/**
 * Masks stream ids (`<ms>-<seq>`) generated from the clock (XADD *). Why: the millisecond part is wall-clock time.
 * Ids are masked consistently inside one reply, so ordering between generated ids is still visible.
 */
export const streamIds: Normalizer = text((s) => s.replace(/^\d{13,}-\d+$/, 'MS-SEQ'));

/** Composes normalisers left to right. */
export function all(...fns: Normalizer[]): Normalizer {
  return (reply) => fns.reduce((r, fn) => fn(r), reply);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Masks every non-negative integer reply node with `N` (keeps the type, keeps negative sentinels like -1). */
function maskInt(node: RespNode): RespNode {
  return node.type === ':' && Number(node.head) >= 0 ? { ...node, head: 'N', raw: ':N\r\n' } : node;
}

/**
 * Stream clocks keyed by name: masks the integer that follows `idle`, `seen-time`, `active-time` or `inactive` at any
 * depth (XINFO CONSUMERS, XINFO STREAM FULL; RESP2 flat arrays and RESP3 maps alike). Why: they are milliseconds of
 * wall-clock time since a consumer's last interaction, which differ between two servers by construction. A -1
 * ("never") is kept.
 */
export const streamClocks: Normalizer = (reply) =>
  mapTree(reply, function walk(node: RespNode): RespNode {
    if (!isAggregate(node)) return node;
    const children = node.children.map(walk);
    for (let i = 0; i + 1 < children.length; i++) {
      if (/^(idle|seen-time|active-time|inactive)$/.test(payload(children[i])) && children[i].type !== ':') {
        children[i + 1] = maskInt(children[i + 1]);
      }
    }
    return { ...node, children };
  });

/**
 * Masks integers that look like a Unix time in milliseconds (>= 10^12) at any depth: the delivery times inside XINFO
 * STREAM FULL pending entries. Why: wall-clock time.
 */
export const msClock: Normalizer = (reply) =>
  mapTree(reply, function walk(node: RespNode): RespNode {
    if (isAggregate(node)) return { ...node, children: node.children.map(walk) };
    return node.type === ':' && Number(node.head) >= 1e12 ? maskInt(node) : node;
  });

/**
 * XPENDING extended form: masks the idle time (third element) of every `[id, consumer, idle, deliveries]` entry. Why:
 * milliseconds since the last delivery, a clock reading.
 */
export const pendingIdle: Normalizer = (reply) =>
  mapTree(reply, (node) => {
    if (!isAggregate(node)) return node;
    const children = node.children.map((e) =>
      isAggregate(e) && e.children.length === 4 ? { ...e, children: e.children.map((c, i) => (i === 2 ? maskInt(c) : c)) } : e,
    );
    return { ...node, children };
  });

/**
 * Sorts field/value pairs of a hash reply in either protocol: a flat RESP2 array (HGETALL, HSCAN-like pairs) or a
 * RESP3 map. Why: hashtable-encoded hashes are returned in hash-table iteration order (seed and table size dependent),
 * and `sorted` alone would separate fields from their values in the flat RESP2 form.
 */
export const sortedFieldValues: Normalizer = (reply) => (reply.startsWith('*') ? sortedPairs(reply) : sorted(reply));

/**
 * HELLO: masks the `id` value of the reply (a map in RESP3, a flat array in RESP2). Why: the id is the process'
 * connection counter; every other field (server, version, proto, mode, role, modules) is compared.
 */
export const hello: Normalizer = (reply) =>
  mapTree(reply, (node) => {
    if (node.type !== '%' && node.type !== '*') return node;
    const children = node.children.map((child, i) => {
      const key = i % 2 === 1 ? payload(node.children[i - 1]) : '';
      if (key === 'id') return { ...child, raw: ':N\r\n', head: 'N' };
      return child;
    });
    return { ...node, children };
  });

/**
 * Sorts the field/value pairs of a CONFIG GET-like reply in both protocols (a flat RESP2 array of pairs or a RESP3
 * map). Why: CONFIG GET with several parameters or a glob returns them in the order of Redis' internal config
 * dictionary, a hash-table iteration order.
 */
export const sortedConfig: Normalizer = (reply) => (reply.startsWith('%') ? sorted(reply) : sortedPairs(reply));

/**
 * Masks the channel / pattern (second element) of a pub/sub push (`unsubscribe`, `punsubscribe`, `sunsubscribe`,
 * `pmessage`…). Why: UNSUBSCRIBE without arguments, and a message matching several patterns, walk the server's
 * channel / pattern dictionaries in hash-table order, so the order of the separate replies is not defined; the kind,
 * the counts and the payload are still compared.
 */
export const pubsubChannel: Normalizer = (reply) =>
  mapTree(reply, (node) => {
    if (!isAggregate(node) || node.children.length < 3) return node;
    return { ...node, children: node.children.map((c, i) => (i === 1 ? withPayload(c, 'CH') : c)) };
  });

/**
 * INFO commandstats / LATENCY-like lines: masks `usec=` and `usec_per_call=` values. Why: they are measured
 * execution times; calls / rejected_calls / failed_calls stay compared.
 */
export const commandStats: Normalizer = text((s) => s.replace(/(^|,)(usec|usec_per_call)=[\d.]+/gm, '$1$2=N'));

/**
 * COMMAND / COMMAND INFO: sorts the subcommand list (10th field) of every command entry by name. Why: Redis emits a
 * container command's subcommands in the iteration order of its subcommand dictionary (a hash table).
 */
export const commandInfo: Normalizer = (reply) =>
  mapTree(reply, (node) => {
    if (node.type !== '*') return node;
    const children = node.children.map((entry) => {
      if (entry.type !== '*' || entry.children.length < 10 || !isAggregate(entry.children[9])) return entry;
      const subs = entry.children[9];
      const sortedSubs = { ...subs, children: [...subs.children].sort((a, b) => cmp(a.raw, b.raw)) };
      const fields = [...entry.children];
      fields[9] = { ...sortedSubs, raw: serialize(sortedSubs) };
      return { ...entry, children: fields };
    });
    return { ...node, children };
  });

/**
 * INFO: keeps section headers and field names, drops every value (`field:value` becomes `field`). Why: INFO values
 * are process figures (pids, run ids, uptimes, clocks, memory, CPU, ports, replication ids); the field set and its
 * order are what a scenario compares. Field-set differences between versions are classified per section in
 * info.differential.test.ts.
 */
export const infoKeys: Normalizer = text((s) => s.replace(/^([^#\r\n:][^:\r\n]*):[^\r\n]*/gm, '$1'));

/** INFO keyspace: masks the `avg_ttl=` value. Why: it is the remaining time to live, which decreases with the clock. */
export const keyspaceInfo: Normalizer = text((s) => s.replace(/avg_ttl=\d+/g, 'avg_ttl=N'));

/**
 * INFO commandstats / latencystats: sorts the field lines of each section. Why: Redis walks its command table (a hash
 * table) to print them, so the line order is hash-table iteration order. (Errorstats come from a radix tree in
 * lexicographic order and must not use this.)
 */
export const sortedInfoLines: Normalizer = text((s) =>
  s.split(/(?=^# )/m).map((section) => {
    const lines = section.split('\r\n');
    const head = lines[0].startsWith('# ') ? [lines.shift() as string] : [];
    const body = lines.filter((l) => l !== '').sort(cmp);
    const tail = lines.length > body.length ? lines.slice(body.length).filter((l) => l === '') : [];
    return [...head, ...body, ...tail].join('\r\n');
  }).join(''),
);

/**
 * ACL LIST / GETUSER: sorts each run of single-command rules (`-keys -sort_ro`, `+get +set +select|0`). Why: Redis 7.0
 * rebuilds the description from the command bitmap and lists the single commands in command-table (hash-table) order;
 * the base and the category rules (`-@all +@read`) are deterministic and stay in place.
 */
export const aclRules: Normalizer = text((s) =>
  s.replace(/[+-][^\s@(#~&%][^\s)]*(?: [+-][^\s@(#~&%][^\s)]*)+/g, (run) => run.split(' ').sort(cmp).join(' ')),
);

/**
 * A remaining time in ms (PTTL) rounded to whole seconds, exactly (int64). Why: the milliseconds that pass between the
 * command that set the TTL and PTTL are a clock reading; the seconds still show a wrong or imprecise expiry.
 */
export const pttlSeconds: Normalizer = (reply) =>
  reply.replace(/^:(\d{4,})\r\n$/, (_, ms: string) => `:${(BigInt(ms) + 500n) / 1000n}000\r\n`);
