# @kuraykaraaslan/redis-lite

[![npm](https://img.shields.io/npm/v/@kuraykaraaslan/redis-lite.svg)](https://www.npmjs.com/package/@kuraykaraaslan/redis-lite)
![node](https://img.shields.io/node/v/@kuraykaraaslan/redis-lite.svg)
![license](https://img.shields.io/npm/l/@kuraykaraaslan/redis-lite.svg)

**A Redis-compatible server written in TypeScript. Run your Redis-backed Node.js app without installing Redis.**

redis-lite speaks the Redis protocol (RESP2 and RESP3) and aims to behave **exactly like Redis 7.0.15**: the same replies, the same error texts, the same object encodings and the same binary formats. Point `REDIS_URL` at it and your code keeps working, including **BullMQ**, Lua scripts, Redis Functions, streams with consumer groups, geo, bitmaps and HyperLogLog. It supports **all 240 commands of Redis 7.0.15** and needs no Docker, no native build and no code changes.

```bash
npx @kuraykaraaslan/redis-lite
# redis-lite listening on redis://127.0.0.1:6379
```

> [!IMPORTANT]
> **No performance guarantees.** redis-lite is a single Node.js process. It makes **no commitment** on throughput, latency, memory use or scalability, and it is slower than Redis. Measure it against your own workload before relying on it (see [Benchmarks](#benchmarks)).
>
> **Good fits:** development, CI, tests, and small single-node installs. **Not a fit:** high-volume production traffic, or anything that needs clustering or automatic failover (no sentinel / cluster; replication with a manual or `FAILOVER`-driven switch is available).
>
> **Persistence:** the CLI persists like Redis (RDB save points on, AOF off, files in the current directory). Servers started from code stay in memory unless you pass persistence options (see [From code](#from-code)).

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
npx @kuraykaraaslan/redis-lite /path/to/redis.conf --port 6380
```

| Option | Env variable | Default |
|---|---|---|
| `-p, --port <n>` | `REDIS_LITE_PORT` | `6379` |
| `-h, --host <addr>` | `REDIS_LITE_HOST` | `127.0.0.1` |
| `--password <pw>` | `REDIS_LITE_PASSWORD` | none (the `default` user is `nopass`) |
| `--databases <n>` | | `16` |
| `--dir <path>` | `REDIS_LITE_DIR` | current directory |
| `--dbfilename <name>` | `REDIS_LITE_DBFILENAME` | `dump.rdb` |
| `--appendonly yes\|no` | `REDIS_LITE_APPENDONLY` | `no` |
| `--save "<seconds> <changes> ..."` | `REDIS_LITE_SAVE` | `"3600 1 300 100 60 10000"` (`""` disables RDB snapshots) |
| `--replicaof "<host> <port>"` | | none (start as a master) |
| `--log-level <level>` | `REDIS_LITE_LOG_LEVEL` | `warn` (`silent`, `warn`, `info`, `debug`) |

**Config file.** An optional `redis.conf` path can be given as the first argument. It uses the redis.conf syntax: one `name value` directive per line, `#` comments, quoted arguments (`"double"` with escapes, `'single'`), `include <path>`, and repeated `save` lines that add save points (`save ""` clears them). `port`, `bind` (first address), `requirepass`, `databases`, `aclfile`, `dir`, `dbfilename`, `appendonly` and `save` map to the options above; every other directive redis-lite knows is applied as with `CONFIG SET`. Directives redis-lite does not support are reported on stderr and ignored (Redis refuses to start). Precedence: command-line options, then the config file, then the environment.

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

`RedisLite.start(options)` accepts `port`, `host`, `password`, `databases`, `logLevel`, `aclfile`, the persistence options `dir`, `dbfilename`, `appendonly` (boolean or `'yes'`/`'no'`) and `save`, and `config` (any other config directive, e.g. `{ 'maxmemory': '100mb', 'maxmemory-policy': 'allkeys-lru' }`).

Without any of `dir`, `dbfilename`, `appendonly` or `save`, the server stays **in memory**: no save points, no AOF, nothing loaded at startup. Giving any of them turns persistence on with Redis's defaults for the rest (save points `3600 1 300 100 60 10000`, `appendonly no`, `dir` = current directory): the RDB / AOF in `dir` is loaded at startup and `close()` saves like a `SIGTERM` does.

```ts
const server = await RedisLite.start({ port: 6379, dir: './data', appendonly: true });
```

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

redis-lite reports itself as **Redis 7.0.15** (`INFO`, `HELLO`, `LOLWUT`, Lua's `redis.REDIS_VERSION`) with `maxmemory-policy noeviction` by default, so version and eviction-policy checks pass.

Tested end to end with real clients:

| Library | Version | What's covered |
|---|---|---|
| **ioredis** | 5.8 | commands, pipelines, `multi`, `watch`, `eval`, `defineCommand`, pub/sub, sharded pub/sub, `monitor`, blocking commands, binary values |
| **BullMQ** | 5.66 and 6.7 | queues, workers, delayed jobs, retries and backoff, priorities, `QueueEvents`, `FlowProducer`, job schedulers (repeat), rate limiter, pause/resume, `getWorkers`, `obliterate`, progress and logs |

The test suite has **over 8,700 tests**; more than 7,000 of them compare redis-lite byte for byte with a real Redis 7.0.15 (see [docs/DIFFERENTIAL.md](docs/DIFFERENTIAL.md)).

### What behaves like Redis

- **Protocol:** RESP2 and RESP3 (`HELLO 3`) with Redis's per-command reply types (maps, sets, doubles, push messages, verbatim strings), pipelining, inline commands with Redis's quoting rules, Redis's protocol error texts and limits.
- **Object encodings:** `int`/`embstr`/`raw`, `listpack`/`hashtable`, `intset`/`hashtable`, `listpack`/`skiplist`, `quicklist` (with listpack nodes), with Redis's conversion thresholds (configurable with `CONFIG SET`) and one-way conversion rules. `OBJECT ENCODING` reports them.
- **SCAN family:** real cursors; compact encodings return everything in one call, large ones are paginated by `COUNT`, as in Redis.
- **64-bit integers** everywhere Redis uses them (`INCR`, `HINCRBY`, `BITFIELD`, expire times), stream IDs over the full unsigned 64-bit range.
- **Streams** stored as Redis stores them: nodes of `stream-node-max-entries` / `stream-node-max-bytes`, so `MAXLEN ~` / `MINID ~` trim whole nodes exactly like Redis. Consumer groups with Redis's lag and entries-read accounting.
- **HyperLogLog** with Redis's algorithm and byte format (MurmurHash64A, sparse/dense representation, Ertl estimator), `PFDEBUG`, `PFSELFTEST`.
- **`DUMP` / `RESTORE` and `FUNCTION DUMP` / `RESTORE`** in the real RDB format (CRC64, LZF, listpack/intset/quicklist encodings).
- **`WATCH`** fires only on real modifications, like Redis's `signalModifiedKey`.
- **LRU/LFU** access tracking: `OBJECT IDLETIME`, `OBJECT FREQ` (Redis's logarithmic counter and decay).
- **Observability:** `INFO` with Redis's sections including `commandstats` and `errorstats`, a real `SLOWLOG`, `COMMAND INFO` / `DOCS` / `GETKEYS` driven by full command metadata (key specs, ACL categories, tips).
- **`CONFIG`:** Redis's config table with types, bounds, memory units, aliases and error texts; settings take effect.
- **Persistence:** RDB snapshots (`SAVE`, `BGSAVE [SCHEDULE]`, save points, `LASTSAVE`, load at startup, `DEBUG RELOAD`), the multi-part AOF of Redis 7+ (manifest, base + incr files, `appendfsync`, `BGREWRITEAOF`, automatic rewrites, `DEBUG LOADAOF`, `aof-load-truncated`), `SHUTDOWN [NOSAVE|SAVE] [NOW] [FORCE] [ABORT]`, `MISCONF` write denial after a failed save, `INFO persistence`. Commands are propagated the way Redis propagates them (relative expires made absolute, scripts and `MULTI` as one `MULTI … EXEC` unit, blocking pops as their non-blocking forms, expired keys as `DEL`).
- **Eviction:** `maxmemory` with every `maxmemory-policy` (`noeviction`, `allkeys-`/`volatile-` `lru`, `lfu`, `random`, `volatile-ttl`), approximated by sampling `maxmemory-samples` keys into a candidate pool, `maxmemory-eviction-tenacity`, the `OOM command not allowed when used memory > 'maxmemory'.` error for `denyoom` commands (also inside `MULTI` and scripts), `evicted_keys`, the `evicted` keyspace event and `DEL` propagation. Used memory follows Redis's accounting and is tracked incrementally.
- **Keyspace notifications:** `notify-keyspace-events` with every class, including `new` (`n`), `expired` (`x`), `evicted` (`e`) and `keymiss` (`m`), for commands run directly, in `MULTI`, in scripts and when a blocked client is served.
- **Client-side caching:** `CLIENT TRACKING` default mode, `BCAST` with `PREFIX`, `OPTIN` / `OPTOUT` with `CLIENT CACHING`, `NOLOOP`, `REDIRECT` (RESP2 via `__redis__:invalidate`), RESP3 `invalidate` pushes, null invalidation on flush, `tracking-redir-broken`, `tracking-table-max-keys`, `CLIENT GETREDIR` / `TRACKINGINFO`.

### Supported commands

| Group | Commands |
|---|---|
| Connection | `PING` `ECHO` `SELECT` `AUTH` `HELLO` `RESET` `QUIT` `READONLY` `READWRITE` `CLIENT` (`SETNAME` `GETNAME` `ID` `LIST` `INFO` `KILL` `UNBLOCK` `TRACKING` `CACHING` `GETREDIR` `TRACKINGINFO` `NO-EVICT` `REPLY` `PAUSE` `UNPAUSE` `HELP`) |
| Server | `INFO` `CONFIG` (`GET` `SET` `RESETSTAT` `REWRITE`) `TIME` `DBSIZE` `FLUSHDB` `FLUSHALL` `COMMAND` (`COUNT` `LIST` `INFO` `DOCS` `GETKEYS` `GETKEYSANDFLAGS`) `ACL` `MONITOR` `SLOWLOG` `LATENCY` `MEMORY` `WAIT` `ROLE` `SAVE` `BGSAVE` `BGREWRITEAOF` `LASTSAVE` `SHUTDOWN` `DEBUG` `LOLWUT` |
| Keys | `DEL` `UNLINK` `EXISTS` `TYPE` `TOUCH` `RENAME` `RENAMENX` `COPY` `MOVE` `SWAPDB` `KEYS` `SCAN` `RANDOMKEY` `SORT` `SORT_RO` `DUMP` `RESTORE` `RESTORE-ASKING` `MIGRATE` `OBJECT` `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` `TTL` `PTTL` `EXPIRETIME` `PEXPIRETIME` `PERSIST` |
| Strings | `GET` `SET` (all options) `SETEX` `PSETEX` `SETNX` `GETSET` `GETDEL` `GETEX` `MGET` `MSET` `MSETNX` `INCR` `INCRBY` `DECR` `DECRBY` `INCRBYFLOAT` `APPEND` `STRLEN` `GETRANGE` `SETRANGE` `SUBSTR` `LCS` |
| Bitmaps | `SETBIT` `GETBIT` `BITCOUNT` `BITPOS` `BITOP` `BITFIELD` `BITFIELD_RO` |
| Hashes | `HSET` `HMSET` `HSETNX` `HGET` `HMGET` `HGETALL` `HDEL` `HEXISTS` `HLEN` `HKEYS` `HVALS` `HSTRLEN` `HINCRBY` `HINCRBYFLOAT` `HSCAN` `HRANDFIELD` |
| Lists | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` `LMPOP` `LLEN` `LRANGE` `LINDEX` `LSET` `LREM` `LTRIM` `LINSERT` `LPOS` `LMOVE` `RPOPLPUSH` `BLPOP` `BRPOP` `BLMPOP` `BLMOVE` `BRPOPLPUSH` |
| Sets | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SMISMEMBER` `SCARD` `SPOP` `SRANDMEMBER` `SMOVE` `SUNION` `SINTER` `SDIFF` `SINTERCARD` `SUNIONSTORE` `SINTERSTORE` `SDIFFSTORE` `SSCAN` |
| Sorted sets | `ZADD` `ZINCRBY` `ZREM` `ZCARD` `ZSCORE` `ZMSCORE` `ZCOUNT` `ZLEXCOUNT` `ZRANGE` `ZREVRANGE` `ZRANGEBYSCORE` `ZREVRANGEBYSCORE` `ZRANGEBYLEX` `ZREVRANGEBYLEX` `ZRANGESTORE` `ZRANK` `ZREVRANK` `ZREMRANGEBYSCORE` `ZREMRANGEBYRANK` `ZREMRANGEBYLEX` `ZPOPMIN` `ZPOPMAX` `ZMPOP` `BZPOPMIN` `BZPOPMAX` `BZMPOP` `ZUNION` `ZINTER` `ZDIFF` `ZUNIONSTORE` `ZINTERSTORE` `ZDIFFSTORE` `ZINTERCARD` `ZSCAN` `ZRANDMEMBER` |
| Geo | `GEOADD` `GEOPOS` `GEODIST` `GEOHASH` `GEOSEARCH` `GEOSEARCHSTORE` `GEORADIUS` `GEORADIUS_RO` `GEORADIUSBYMEMBER` `GEORADIUSBYMEMBER_RO` |
| Streams | `XADD` `XLEN` `XRANGE` `XREVRANGE` `XDEL` `XTRIM` `XREAD` `XGROUP` `XREADGROUP` `XACK` `XPENDING` `XCLAIM` `XAUTOCLAIM` `XINFO` (incl. `STREAM … FULL`) `XSETID` |
| HyperLogLog | `PFADD` `PFCOUNT` `PFMERGE` `PFDEBUG` `PFSELFTEST` |
| Pub/Sub | `SUBSCRIBE` `UNSUBSCRIBE` `PSUBSCRIBE` `PUNSUBSCRIBE` `PUBLISH` `SSUBSCRIBE` `SUNSUBSCRIBE` `SPUBLISH` `PUBSUB` |
| Replication | `REPLICAOF` `SLAVEOF` `ROLE` `WAIT` `FAILOVER` `PSYNC` `SYNC` `REPLCONF` |
| Transactions | `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` |
| Scripting | `EVAL` `EVALSHA` `EVAL_RO` `EVALSHA_RO` `SCRIPT` (`LOAD` `EXISTS` `FLUSH` `KILL`) |
| Functions | `FUNCTION` (`LOAD` `LIST` `DELETE` `FLUSH` `STATS` `DUMP` `RESTORE` `KILL`) `FCALL` `FCALL_RO` |

Any other command gets `ERR unknown command '<name>'`, the same reply Redis gives.

### Lua scripting and Functions

Scripts and functions run on Lua 5.4 (compiled to WASM), with a compatibility layer that makes it behave like the Lua 5.1 inside Redis:

- `redis.call`, `redis.pcall`, `redis.error_reply`, `redis.status_reply`, `redis.sha1hex`, `redis.log`, `redis.setresp` (RESP3 conversions included), `redis.acl_check_cmd` (checked against the ACL user running the script), `redis.register_function` (with flags and description)
- `cjson`, `cmsgpack`, `bit`, `struct`
- Lua 5.1 names: `unpack`, `loadstring`, `table.getn`, `math.pow`, `math.mod`; numbers printed with Lua 5.1's `%.14g` by `tostring`
- Redis's sandbox: global variables are protected (reading an undefined global or creating one is an error)
- Read-only scripts (`EVAL_RO`, `FCALL_RO`, `no-writes` functions) refuse write commands
- Byte-exact strings: binary data such as msgpack payloads passes through unchanged
- Each script runs atomically: no other command runs in the middle of it

## Status

redis-lite targets byte-for-byte parity with Redis 7.0.15. See [docs/PHASES.md](docs/PHASES.md) for the roadmap.

**Wired into the server and tested:**

| Feature | State |
|---|---|
| RDB snapshots (`SAVE`, `BGSAVE`, save points, load at startup, `DEBUG RELOAD`) | Done |
| AOF (multi-part AOF with manifest, `appendfsync`, `BGREWRITEAOF`, `DEBUG LOADAOF`) | Done |
| `SHUTDOWN` with `NOSAVE` / `SAVE` / `NOW` / `FORCE` / `ABORT`, `MISCONF` | Done |
| ACL users and permissions (`ACL SETUSER`/`DELUSER`, command/key/channel rules, `NOPERM`, `ACL LOG`, `redis.acl_check_cmd`) | Done |
| `MEMORY USAGE` / `MEMORY STATS` / `INFO memory` computed the way Redis computes them | Done |
| `maxmemory` eviction (all policies, `OOM` errors) | Done |
| Keyspace notifications (`notify-keyspace-events`) | Done |
| Client-side caching (`CLIENT TRACKING`) | Done |
| CLI config file (`redis.conf`) | Done |
| Replication: `REPLICAOF` / `replicaof` directive / `--replicaof`, full sync (disk or diskless EOF payload), partial resync from the backlog, PSYNC2 after promotion, chained replicas, read-only replicas, `replica-serve-stale-data`, `WAIT` with real acknowledgements, `min-replicas-to-write`, `FAILOVER`, `ROLE` and `INFO replication` | Done |

**Not available yet:** sentinel and cluster. Loadable modules (`MODULE LOAD`) are not supported.

## Differences from Redis

What still differs from Redis 7.0.15 today:

| Topic | Behaviour |
|---|---|
| Performance | No guarantees of any kind (see the note at the top). |
| Background saves | There is no fork: `BGSAVE` takes the snapshot synchronously and writes the file in the background; `BGREWRITEAOF` runs synchronously (the reply is still Redis's "…started"). |
| Embedded servers | `RedisLite.start()` stays in memory unless persistence options are given (the CLI behaves like Redis). |
| Config file | Unsupported directives are ignored with a warning instead of stopping the server; `CONFIG REWRITE` is not implemented. |
| `rdb_changes_since_last_save` | Counts modified keys per command, not every element changed (Redis counts e.g. each `SADD` member). |
| Eviction | Used memory is Redis's accounting model, not the allocator's real numbers. The tenacity-to-time mapping and the sampling pool are redis-lite's own approximation of the documented behaviour. Scripts and functions without the `allow-oom` flag are not refused up front when out of memory; their write calls get the `OOM` error instead. Client eviction (`maxmemory-clients`) is not implemented. |
| Client-side caching | When `tracking-table-max-keys` is exceeded the oldest tracked keys are dropped (Redis picks random ones). |
| Lua number formatting | `tostring()` uses Lua 5.1's `%.14g`, but scripts run on Lua 5.4, which has no negative zero: `tostring(-0)` gives `"0"` where Redis gives `"-0"`. |
| Replication | Interoperability with a real Redis master or replica follows the documented protocol but has only been tested redis-lite to redis-lite. A full sync takes the snapshot synchronously (no fork, no per-replica output buffer); `repl-diskless-load` only decides whether the received RDB is also written to `dbfilename` (it is always parsed before the dataset is replaced, like `swapdb`), and `replica-lazy-flush` has no visible effect. A replica's offset advances at transaction boundaries. `client-output-buffer-limit` for replicas is not enforced. |
| Lua error tables | A script that raises an error table without a string `err` field crashes Redis 7.0.15; redis-lite closes only that client's connection. |
| Not supported | Sentinel, cluster, loadable modules. |

**Verification:** a differential test suite sends the same commands to redis-lite and to a real Redis 7.0.15 over RESP2 and RESP3 and compares the reply bytes, including the whole command table (`COMMAND INFO` / `COMMAND DOCS` of every command), the `CONFIG GET *` table, the `INFO` field set, `DUMP` payloads and HLL bytes (see [docs/DIFFERENTIAL.md](docs/DIFFERENTIAL.md)). Memory figures follow Redis's accounting model and are compared by shape, not by value.

## When not to use it

- **When you need performance.** redis-lite makes no promise about speed or memory use. Use Redis for high-volume traffic, benchmarks and load tests.
- **Production with more than one app node writing.** Locks, idempotency keys and rate limits are only correct if every node writes to one master; replicas give a hot standby and read scaling, not clustering or automatic failover.
- **Data you cannot afford to lose.** RDB and AOF persistence work, but they have not been battle-tested the way Redis's have.

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
                                            ├──▶ pub/sub, sharded pub/sub, keyspace notifications, MONITOR
                                            ├──▶ client-side caching invalidations
                                            ├──▶ propagation ──▶ AOF (RDB snapshots on save points)
                                            └──▶ Lua engine (wasmoon) ── redis.call ──┘
```

Commands run one at a time across all connections, the way Redis runs them. This makes every command, `MULTI`/`EXEC` block, Lua script and function call atomic. Keys expire lazily on access, plus a background sweep every 100 ms. With `maxmemory` set, keys are evicted before a command runs, as in Redis.

## Development

```bash
npm install
npm test            # Vitest: per-module suites (modules/*/tests) and end-to-end suites (tests/)
npm run typecheck
npm run build       # → dist/
npx tsx bench/bench.ts
```

Code layout (modules, libs, the module recipe and the conventions every change follows): [docs/STRUCTURE.md](docs/STRUCTURE.md).

## License

MIT
