# @kuraykaraaslan/redis-lite

[![npm](https://img.shields.io/npm/v/@kuraykaraaslan/redis-lite.svg)](https://www.npmjs.com/package/@kuraykaraaslan/redis-lite)
![node](https://img.shields.io/node/v/@kuraykaraaslan/redis-lite.svg)
![license](https://img.shields.io/npm/l/@kuraykaraaslan/redis-lite.svg)

**A Redis-compatible server written in TypeScript. Run your Redis-backed Node.js app without installing Redis.**

redis-lite speaks the Redis protocol (RESP2 and RESP3) and aims to behave **exactly like Redis 8.8**: the same replies, the same error texts, the same object encodings and the same binary formats. Point `REDIS_URL` at it and your code keeps working, including **BullMQ**, Lua scripts, Redis Functions, streams with consumer groups, geo, bitmaps and HyperLogLog. It supports **241 commands** and needs no Docker, no native build and no code changes.

```bash
npx @kuraykaraaslan/redis-lite
# redis-lite listening on redis://127.0.0.1:6379
```

> [!IMPORTANT]
> **No performance guarantees.** redis-lite is a single Node.js process. It makes **no commitment** on throughput, latency, memory use or scalability, and it is slower than Redis. Measure it against your own workload before relying on it (see [Benchmarks](#benchmarks)).
>
> **Good fits:** development, CI, tests, and small single-node installs. **Not a fit:** high-volume production traffic, or anything that needs replication or clustering (not available yet).
>
> **Data is in memory only for now.** RDB and AOF persistence are implemented and tested but not yet wired into the server, so a restart loses everything (see [Status](#status)).

---

## Why

- **Your stack needs Redis, your machine doesn't have it.** Start redis-lite with `npx` instead of installing Redis or running Docker.
- **Tests that need a real Redis.** Start a fresh server on a random port per test suite in milliseconds. Mocks break as soon as BullMQ runs a Lua script; redis-lite runs the script.
- **Same client code.** redis-lite is a real TCP server, so your app, your BullMQ workers and your socket.io gateway can run as separate processes and share one instance, as they would with Redis.

## Install

```bash
npm install @kuraykaraaslan/redis-lite
```

Requires Node.js 20 or newer. Pure JavaScript plus a WASM Lua engine: no native dependencies, works on Linux, macOS and Windows.

## Usage

### Command line

```bash
npx @kuraykaraaslan/redis-lite --port 6379
```

| Option | Env variable | Default |
|---|---|---|
| `-p, --port <n>` | `REDIS_LITE_PORT` | `6379` |
| `-h, --host <addr>` | `REDIS_LITE_HOST` | `127.0.0.1` |
| `--password <pw>` | `REDIS_LITE_PASSWORD` | none (the `default` user is `nopass`) |
| `--databases <n>` | | `16` |
| `--log-level <level>` | `REDIS_LITE_LOG_LEVEL` | `warn` (`silent`, `warn`, `info`, `debug`) |

With `--log-level warn`, any command redis-lite doesn't support is logged, so gaps show up quickly. Runtime settings are changed with `CONFIG SET`, as in Redis.

Typical `package.json` setup next to your dev server:

```json
{
  "scripts": {
    "redis": "redis-lite --port 6379",
    "dev": "concurrently \"npm:redis\" \"next dev\""
  }
}
```

### From code

```ts
import { RedisLite } from '@kuraykaraaslan/redis-lite';

const server = await RedisLite.start({ port: 0 }); // 0 = pick a free port
console.log(server.url);                          // redis://127.0.0.1:53817

// ... use it ...

await server.close();
```

`RedisLite.start(options)` accepts the same options as the CLI: `port`, `host`, `password`, `databases`, `logLevel`.

### In tests (Vitest / Jest)

```ts
import Redis from 'ioredis';
import { RedisLite } from '@kuraykaraaslan/redis-lite';

let server: RedisLite;
let redis: Redis;

beforeAll(async () => {
  server = await RedisLite.start({ port: 0 });
  redis = new Redis(server.url);
});

afterAll(async () => {
  redis.disconnect();
  await server.close();
});

it('counts', async () => {
  expect(await redis.incr('hits')).toBe(1);
});
```

Each `start()` is an isolated server, so test files never share state.

### With BullMQ

Nothing special. Use it like any Redis:

```ts
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis(server.url, { maxRetriesPerRequest: null });

const queue = new Queue('mail', { connection });
new Worker('mail', async (job) => sendMail(job.data), { connection });

await queue.add('welcome', { to: 'someone@example.com' }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
```

## Compatibility

redis-lite reports itself as **Redis 8.8.4** (`INFO`, `HELLO`, `LOLWUT`, Lua's `redis.REDIS_VERSION`) with `maxmemory-policy noeviction`, so version and eviction-policy checks pass.

Tested end to end with real clients:

| Library | Version | What's covered |
|---|---|---|
| **ioredis** | 5.8 | commands, pipelines, `multi`, `watch`, `eval`, `defineCommand`, pub/sub, sharded pub/sub, `monitor`, blocking commands, binary values |
| **BullMQ** | 5.66 and 6.7 | queues, workers, delayed jobs, retries and backoff, priorities, `QueueEvents`, `FlowProducer`, job schedulers (repeat), rate limiter, pause/resume, `getWorkers`, `obliterate`, progress and logs |

The test suite has **over 1,000 tests**, most of them written from the Redis documentation and Redis's known behaviour rather than from redis-lite's own output.

### What behaves like Redis

- **Protocol:** RESP2 and RESP3 (`HELLO 3`) with Redis's per-command reply types (maps, sets, doubles, push messages, verbatim strings), pipelining, inline commands with Redis's quoting rules, Redis's protocol error texts and limits.
- **Object encodings:** `int`/`embstr`/`raw`, `listpack`/`listpackex`/`hashtable`, `intset`/`listpack`/`hashtable`, `listpack`/`skiplist`, `listpack`/`quicklist`, with Redis's conversion thresholds (configurable with `CONFIG SET`) and one-way conversion rules. `OBJECT ENCODING` reports them.
- **SCAN family:** real cursors; compact encodings return everything in one call, large ones are paginated by `COUNT`, as in Redis.
- **64-bit integers** everywhere Redis uses them (`INCR`, `HINCRBY`, `BITFIELD`, expire times), stream IDs over the full unsigned 64-bit range.
- **Streams** stored as Redis stores them: nodes of `stream-node-max-entries` / `stream-node-max-bytes`, so `MAXLEN ~` / `MINID ~` trim whole nodes exactly like Redis. Consumer groups with Redis's lag and entries-read accounting.
- **HyperLogLog** with Redis's algorithm and byte format (MurmurHash64A, sparse/dense representation, Ertl estimator), `PFDEBUG`, `PFSELFTEST`.
- **`DUMP` / `RESTORE` and `FUNCTION DUMP` / `RESTORE`** in the real RDB format (CRC64, LZF, listpack/intset/quicklist encodings).
- **`WATCH`** fires only on real modifications, like Redis's `signalModifiedKey`.
- **LRU/LFU** access tracking: `OBJECT IDLETIME`, `OBJECT FREQ` (Redis's logarithmic counter and decay), `CLIENT NO-TOUCH`.
- **Observability:** `INFO` with Redis's sections including `commandstats` and `errorstats`, a real `SLOWLOG`, `COMMAND INFO` / `DOCS` / `GETKEYS` driven by full command metadata (key specs, ACL categories, tips).
- **`CONFIG`:** Redis's config table with types, bounds, memory units, aliases and error texts; settings take effect.

### Supported commands

| Group | Commands |
|---|---|
| Connection | `PING` `ECHO` `SELECT` `AUTH` `HELLO` `RESET` `QUIT` `READONLY` `READWRITE` `CLIENT` (`SETNAME` `GETNAME` `ID` `LIST` `INFO` `SETINFO` `KILL` `UNBLOCK` `GETREDIR` `TRACKINGINFO` `NO-EVICT` `NO-TOUCH` `REPLY` `PAUSE` `UNPAUSE` `HELP`) |
| Server | `INFO` `CONFIG` (`GET` `SET` `RESETSTAT` `REWRITE`) `TIME` `DBSIZE` `FLUSHDB` `FLUSHALL` `COMMAND` (`COUNT` `LIST` `INFO` `DOCS` `GETKEYS` `GETKEYSANDFLAGS`) `ACL` `MONITOR` `SLOWLOG` `LATENCY` `MEMORY` `WAIT` `WAITAOF` `ROLE` `SAVE` `BGSAVE` `LASTSAVE` `SHUTDOWN` `DEBUG` `LOLWUT` |
| Keys | `DEL` `UNLINK` `EXISTS` `TYPE` `TOUCH` `RENAME` `RENAMENX` `COPY` `MOVE` `SWAPDB` `KEYS` `SCAN` `RANDOMKEY` `SORT` `SORT_RO` `DUMP` `RESTORE` `OBJECT` `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` `TTL` `PTTL` `EXPIRETIME` `PEXPIRETIME` `PERSIST` |
| Strings | `GET` `SET` (all options) `SETEX` `PSETEX` `SETNX` `GETSET` `GETDEL` `GETEX` `MGET` `MSET` `MSETNX` `INCR` `INCRBY` `DECR` `DECRBY` `INCRBYFLOAT` `APPEND` `STRLEN` `GETRANGE` `SETRANGE` `SUBSTR` `LCS` |
| Bitmaps | `SETBIT` `GETBIT` `BITCOUNT` `BITPOS` `BITOP` (incl. `DIFF` `DIFF1` `ANDOR` `ONE`) `BITFIELD` `BITFIELD_RO` |
| Hashes | `HSET` `HMSET` `HSETNX` `HGET` `HMGET` `HGETALL` `HDEL` `HEXISTS` `HLEN` `HKEYS` `HVALS` `HSTRLEN` `HINCRBY` `HINCRBYFLOAT` `HSCAN` `HRANDFIELD` |
| Hash field TTL | `HEXPIRE` `HPEXPIRE` `HEXPIREAT` `HPEXPIREAT` `HTTL` `HPTTL` `HEXPIRETIME` `HPEXPIRETIME` `HPERSIST` `HGETDEL` `HGETEX` `HSETEX` |
| Lists | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` `LMPOP` `LLEN` `LRANGE` `LINDEX` `LSET` `LREM` `LTRIM` `LINSERT` `LPOS` `LMOVE` `RPOPLPUSH` `BLPOP` `BRPOP` `BLMPOP` `BLMOVE` `BRPOPLPUSH` |
| Sets | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SMISMEMBER` `SCARD` `SPOP` `SRANDMEMBER` `SMOVE` `SUNION` `SINTER` `SDIFF` `SINTERCARD` `SUNIONSTORE` `SINTERSTORE` `SDIFFSTORE` `SSCAN` |
| Sorted sets | `ZADD` `ZINCRBY` `ZREM` `ZCARD` `ZSCORE` `ZMSCORE` `ZCOUNT` `ZLEXCOUNT` `ZRANGE` `ZREVRANGE` `ZRANGEBYSCORE` `ZREVRANGEBYSCORE` `ZRANGEBYLEX` `ZREVRANGEBYLEX` `ZRANGESTORE` `ZRANK` `ZREVRANK` `ZREMRANGEBYSCORE` `ZREMRANGEBYRANK` `ZREMRANGEBYLEX` `ZPOPMIN` `ZPOPMAX` `ZMPOP` `BZPOPMIN` `BZPOPMAX` `BZMPOP` `ZUNION` `ZINTER` `ZDIFF` `ZUNIONSTORE` `ZINTERSTORE` `ZDIFFSTORE` `ZINTERCARD` `ZSCAN` (incl. `NOSCORES`) `ZRANDMEMBER` |
| Geo | `GEOADD` `GEOPOS` `GEODIST` `GEOHASH` `GEOSEARCH` `GEOSEARCHSTORE` `GEORADIUS` `GEORADIUS_RO` `GEORADIUSBYMEMBER` `GEORADIUSBYMEMBER_RO` |
| Streams | `XADD` `XLEN` `XRANGE` `XREVRANGE` `XDEL` `XTRIM` `XREAD` `XGROUP` `XREADGROUP` `XACK` `XPENDING` `XCLAIM` `XAUTOCLAIM` `XINFO` (incl. `STREAM … FULL`) `XSETID` |
| HyperLogLog | `PFADD` `PFCOUNT` `PFMERGE` `PFDEBUG` `PFSELFTEST` |
| Pub/Sub | `SUBSCRIBE` `UNSUBSCRIBE` `PSUBSCRIBE` `PUNSUBSCRIBE` `PUBLISH` `SSUBSCRIBE` `SUNSUBSCRIBE` `SPUBLISH` `PUBSUB` |
| Transactions | `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` |
| Scripting | `EVAL` `EVALSHA` `EVAL_RO` `EVALSHA_RO` `SCRIPT` (`LOAD` `EXISTS` `FLUSH` `KILL`) |
| Functions | `FUNCTION` (`LOAD` `LIST` `DELETE` `FLUSH` `STATS` `DUMP` `RESTORE` `KILL`) `FCALL` `FCALL_RO` |

Any other command gets `ERR unknown command '<name>'`, the same reply Redis gives.

### Lua scripting and Functions

Scripts and functions run on Lua 5.4 (compiled to WASM), with a compatibility layer that makes it behave like the Lua 5.1 inside Redis:

- `redis.call`, `redis.pcall`, `redis.error_reply`, `redis.status_reply`, `redis.sha1hex`, `redis.log`, `redis.setresp` (RESP3 conversions included), `redis.register_function` (with flags and description)
- `cjson`, `cmsgpack`, `bit`, `struct`
- Lua 5.1 names: `unpack`, `loadstring`, `table.getn`, `math.pow`, `math.mod`; numbers printed with Lua 5.1's `%.14g` by `tostring`
- Redis's sandbox: global variables are protected (reading an undefined global or creating one is an error)
- Read-only scripts (`EVAL_RO`, `FCALL_RO`, `no-writes` functions) refuse write commands
- Byte-exact strings: binary data such as msgpack payloads passes through unchanged
- Each script runs atomically: no other command runs in the middle of it

## Status

redis-lite is under active development towards full Redis 8.8 parity. See [docs/PHASES.md](docs/PHASES.md) for the roadmap.

**Implemented and tested, being wired into the server:**

| Feature | State |
|---|---|
| RDB snapshots (`SAVE`, `BGSAVE`, save points, load at startup, `DEBUG RELOAD`) | Module done, not wired yet |
| AOF (multi-part AOF with manifest, `appendfsync`, `BGREWRITEAOF`) | Module done, not wired yet |
| ACL users and permissions (`ACL SETUSER`/`DELUSER`, command/key/channel rules, `NOPERM`, `ACL LOG`) | Module done, being wired |
| `MEMORY USAGE` / `MEMORY STATS` / `INFO memory` computed the way Redis computes them | Module done, being wired |
| Keyspace notifications (`notify-keyspace-events`) | Module done, not wired yet |

**Not available yet:** `maxmemory` eviction, client-side caching (`CLIENT TRACKING`), replication, sentinel, cluster, and the modules bundled with Redis 8 (JSON, Search, time series, probabilistic, vector sets).

## Differences from Redis

What still differs from Redis 8.8 today:

| Topic | Behaviour |
|---|---|
| Performance | No guarantees of any kind (see the note at the top). |
| Persistence | In memory only until the RDB/AOF modules are wired in (see [Status](#status)). |
| `ACL` | Today a single `default` user (with `--password`); full ACL is being wired in. |
| `MEMORY`, `INFO memory`, `LATENCY` | Placeholder values until the memory accounting module is wired in; `LATENCY` does not record events yet. |
| Eviction | `maxmemory` is accepted but not enforced yet. |
| Lua number formatting | `tostring()` uses Lua 5.1's `%.14g`, but `..` concatenation still uses Lua 5.4 rules (`10/2 .. ''` gives `"5.0"`, Redis gives `"5"`). |
| Not supported | Replication, sentinel, cluster, client-side caching, Redis 8 modules (JSON, Search, time series, probabilistic, vector sets). |

**Verification:** expected behaviour comes from the Redis documentation and Redis's known behaviour. A byte-for-byte differential test suite against a real Redis 8.8 server is planned; until it runs, some binary details (exact RDB version number, HLL bytes, memory numbers) are unverified.

## When not to use it

- **When you need performance.** redis-lite makes no promise about speed or memory use. Use Redis for high-volume traffic, benchmarks and load tests.
- **Production with more than one app node.** Locks, idempotency keys and rate limits are only correct if every node shares one server, and redis-lite has no replication or clustering yet.
- **Data you need to keep**, until persistence is wired in.

## Benchmarks

Indicative only, not a promise. Pipelined commands (1,000 per batch) through ioredis against an in-process server on one machine (`npx tsx bench/bench.ts`):

| Command | ops/sec |
|---|---|
| `SET` | ~70,000 |
| `GET` | ~94,000 |
| `INCR` | ~95,000 |
| `HSET` (one hash, 50k fields) | ~82,000 |
| `SADD` (one set, 50k members) | ~90,000 |
| `ZADD` (one zset, 50k members) | ~72,000 |
| `LPUSH` (one list, 50k elements) | ~22,000 |
| `RPOP` | ~98,000 |
| `XADD … MAXLEN ~ 10000` | ~53,000 |
| `PFADD` | ~48,000 |
| `EVAL` (small script) | ~26,000 |

Run it on your own hardware and with your own data shapes before relying on these numbers.

## How it works

```
client ──TCP/RESP2·RESP3──▶ parser ──▶ command table ──▶ in-memory keyspace (16 databases)
                                            │
                                            ├──▶ blocking waiters (BLPOP, BZPOPMIN, XREAD BLOCK …)
                                            ├──▶ pub/sub, sharded pub/sub and MONITOR
                                            └──▶ Lua engine (wasmoon) ── redis.call ──┘
```

Commands run one at a time across all connections, the way Redis runs them. This makes every command, `MULTI`/`EXEC` block, Lua script and function call atomic. Keys expire lazily on access, plus a background sweep every 100 ms.

## Development

```bash
npm install
npm test            # Vitest: unit, per-command-group and ioredis/BullMQ end-to-end suites
npm run typecheck
npm run build       # → dist/
npx tsx bench/bench.ts
```

## License

MIT
