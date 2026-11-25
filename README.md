# @kuraykaraaslan/redis-lite

[![npm](https://img.shields.io/npm/v/@kuraykaraaslan/redis-lite.svg)](https://www.npmjs.com/package/@kuraykaraaslan/redis-lite)
![node](https://img.shields.io/node/v/@kuraykaraaslan/redis-lite.svg)
![license](https://img.shields.io/npm/l/@kuraykaraaslan/redis-lite.svg)

**Run your Redis-backed Node.js app without Redis.**

redis-lite is a small, in-memory server that speaks the Redis protocol. Point `REDIS_URL` at it and your existing code keeps working. That includes **BullMQ** queues, Lua scripts, Redis Functions, streams, geo and pub/sub. You don't need Docker, a native build or code changes. It supports **239 commands**.

```bash
npx @kuraykaraaslan/redis-lite
# redis-lite listening on redis://127.0.0.1:6379
```

> [!IMPORTANT]
> **No performance guarantees.** redis-lite aims to give the same answers Redis gives. It does not aim to match Redis's speed, and it makes **no commitment** on throughput, latency, memory use or scalability. Don't benchmark it, load-test against it or run production traffic through it.
>
> It is meant for development, CI, tests and single-node demos. Data lives in memory and is gone on restart. There is one process, with no cluster and no replication.

---

## Why

- **Your stack needs Redis, your laptop doesn't have it.** Start redis-lite with `npx` instead of installing Redis or running Docker.
- **Tests that need a real Redis.** Start a fresh server on a random port per test suite in a few milliseconds. Mocks break as soon as BullMQ runs a Lua script; redis-lite runs the script.
- **Same client code.** redis-lite is a real TCP server, so your app, your BullMQ workers and your socket.io gateway can run as separate processes and still share one Redis, as they would in production.

## Install

```bash
npm install --save-dev @kuraykaraaslan/redis-lite
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
| `--password <pw>` | `REDIS_LITE_PASSWORD` | none (no `AUTH` needed) |
| `--databases <n>` | | `16` |
| `--log-level <level>` | `REDIS_LITE_LOG_LEVEL` | `warn` (`silent`, `warn`, `info`, `debug`) |

With `--log-level warn`, any command redis-lite doesn't support is logged, so you can spot gaps quickly.

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

Tested end to end with real clients:

| Library | Version | What's covered |
|---|---|---|
| **ioredis** | 5.8 | commands, pipelines, `multi`, `watch`, `eval`, `defineCommand`, pub/sub, sharded pub/sub, `monitor`, blocking commands, binary values |
| **BullMQ** | 5.66 and 6.7 | queues, workers, delayed jobs, retries and backoff, priorities, `QueueEvents`, `FlowProducer`, job schedulers (repeat), rate limiter, pause/resume, `getWorkers`, `obliterate`, progress and logs |

redis-lite reports itself as Redis `7.2.0` with `maxmemory-policy noeviction`, so version and eviction-policy checks pass. It also supports the hash field expiration commands that arrived in Redis 7.4 and 8.0.

### Supported commands

| Group | Commands |
|---|---|
| Connection | `PING` `ECHO` `SELECT` `AUTH` `HELLO` `RESET` `QUIT` `READONLY` `READWRITE` `CLIENT` (`SETNAME` `GETNAME` `ID` `LIST` `INFO` `SETINFO` `KILL` `UNBLOCK` `GETREDIR` `TRACKINGINFO` `NO-EVICT` `NO-TOUCH` `REPLY` `PAUSE` `UNPAUSE`) |
| Server | `INFO` `CONFIG` (`GET` `SET` `RESETSTAT` `REWRITE`) `TIME` `DBSIZE` `FLUSHDB` `FLUSHALL` `COMMAND` (`COUNT` `LIST` `INFO` `DOCS` `GETKEYS` `GETKEYSANDFLAGS`) `ACL` (`WHOAMI` `USERS` `LIST` `CAT` `GETUSER` `DRYRUN` `LOG` `GENPASS`) `MONITOR` `SLOWLOG` `LATENCY` `MEMORY` `WAIT` `WAITAOF` `ROLE` `SAVE` `BGSAVE` `LASTSAVE` `SHUTDOWN` `DEBUG` `LOLWUT` |
| Keys | `DEL` `UNLINK` `EXISTS` `TYPE` `TOUCH` `RENAME` `RENAMENX` `COPY` `MOVE` `SWAPDB` `KEYS` `SCAN` `RANDOMKEY` `SORT` `SORT_RO` `DUMP` `RESTORE` `OBJECT` `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` `TTL` `PTTL` `EXPIRETIME` `PEXPIRETIME` `PERSIST` |
| Strings | `GET` `SET` (all options) `SETEX` `PSETEX` `SETNX` `GETSET` `GETDEL` `GETEX` `MGET` `MSET` `MSETNX` `INCR` `INCRBY` `DECR` `DECRBY` `INCRBYFLOAT` `APPEND` `STRLEN` `GETRANGE` `SETRANGE` `SUBSTR` `LCS` |
| Bitmaps | `SETBIT` `GETBIT` `BITCOUNT` `BITPOS` `BITOP` `BITFIELD` `BITFIELD_RO` |
| Hashes | `HSET` `HMSET` `HSETNX` `HGET` `HMGET` `HGETALL` `HDEL` `HEXISTS` `HLEN` `HKEYS` `HVALS` `HSTRLEN` `HINCRBY` `HINCRBYFLOAT` `HSCAN` `HRANDFIELD` |
| Hash field TTL | `HEXPIRE` `HPEXPIRE` `HEXPIREAT` `HPEXPIREAT` `HTTL` `HPTTL` `HEXPIRETIME` `HPEXPIRETIME` `HPERSIST` `HGETDEL` `HGETEX` `HSETEX` |
| Lists | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` `LMPOP` `LLEN` `LRANGE` `LINDEX` `LSET` `LREM` `LTRIM` `LINSERT` `LPOS` `LMOVE` `RPOPLPUSH` `BLPOP` `BRPOP` `BLMPOP` `BLMOVE` `BRPOPLPUSH` |
| Sets | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SMISMEMBER` `SCARD` `SPOP` `SRANDMEMBER` `SMOVE` `SUNION` `SINTER` `SDIFF` `SINTERCARD` `SUNIONSTORE` `SINTERSTORE` `SDIFFSTORE` `SSCAN` |
| Sorted sets | `ZADD` (`NX` `XX` `GT` `LT` `CH` `INCR`) `ZINCRBY` `ZREM` `ZCARD` `ZSCORE` `ZMSCORE` `ZCOUNT` `ZLEXCOUNT` `ZRANGE` (`BYSCORE` `BYLEX` `REV` `LIMIT`) `ZREVRANGE` `ZRANGEBYSCORE` `ZREVRANGEBYSCORE` `ZRANGEBYLEX` `ZREVRANGEBYLEX` `ZRANGESTORE` `ZRANK` `ZREVRANK` `ZREMRANGEBYSCORE` `ZREMRANGEBYRANK` `ZREMRANGEBYLEX` `ZPOPMIN` `ZPOPMAX` `ZMPOP` `BZPOPMIN` `BZPOPMAX` `BZMPOP` `ZUNION` `ZINTER` `ZDIFF` `ZUNIONSTORE` `ZINTERSTORE` `ZDIFFSTORE` `ZINTERCARD` `ZSCAN` `ZRANDMEMBER` |
| Geo | `GEOADD` `GEOPOS` `GEODIST` `GEOHASH` `GEOSEARCH` `GEOSEARCHSTORE` `GEORADIUS` `GEORADIUS_RO` `GEORADIUSBYMEMBER` `GEORADIUSBYMEMBER_RO` |
| Streams | `XADD` `XLEN` `XRANGE` `XREVRANGE` `XDEL` `XTRIM` `XREAD` (with `BLOCK`) `XGROUP` `XREADGROUP` (with `BLOCK`) `XACK` `XPENDING` `XCLAIM` `XAUTOCLAIM` `XINFO` `XSETID` |
| HyperLogLog | `PFADD` `PFCOUNT` `PFMERGE` |
| Pub/Sub | `SUBSCRIBE` `UNSUBSCRIBE` `PSUBSCRIBE` `PUNSUBSCRIBE` `PUBLISH` `SSUBSCRIBE` `SUNSUBSCRIBE` `SPUBLISH` `PUBSUB` |
| Transactions | `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` |
| Scripting | `EVAL` `EVALSHA` `EVAL_RO` `EVALSHA_RO` `SCRIPT` (`LOAD` `EXISTS` `FLUSH` `KILL`) |
| Functions | `FUNCTION` (`LOAD` `LIST` `DELETE` `FLUSH` `STATS` `DUMP` `RESTORE` `KILL`) `FCALL` `FCALL_RO` |

Any other command gets `ERR unknown command '<name>'`, the same reply real Redis gives.

### Lua scripting and Functions

Scripts and functions run on Lua 5.4 (compiled to WASM), with a compatibility layer that makes it behave like the Lua 5.1 inside Redis:

- `redis.call`, `redis.pcall`, `redis.error_reply`, `redis.status_reply`, `redis.sha1hex`, `redis.log`, `redis.register_function`
- `cjson`, `cmsgpack`, `bit`
- Lua 5.1 names: `unpack`, `loadstring`, `table.getn`, `math.pow`, `math.mod`
- Byte-exact strings: binary data such as msgpack payloads passes through unchanged
- Redis conversion rules: numbers are truncated to integers, `false` becomes nil, and `{ok=...}` / `{err=...}` tables become status and error replies
- Like Redis, each script runs atomically: no other command runs in the middle of it

## Differences from Redis

redis-lite gives the same replies Redis would, but a few things are simplified on purpose:

| Topic | Behaviour |
|---|---|
| Performance | No guarantees of any kind (see the note at the top). |
| Persistence | None. Everything is in memory. `SAVE`/`BGSAVE` reply OK and do nothing. |
| `SCAN` family | Returns every match in one call with cursor `0`. Valid per the Redis contract, just never paginated. |
| HyperLogLog | Exact counting (backed by a set) instead of an estimate. |
| `XADD`/`XTRIM` `~` | Approximate trimming is done exactly. |
| `DUMP`/`RESTORE`, `FUNCTION DUMP`/`RESTORE` | Use redis-lite's own payload format. Payloads from real Redis can't be restored, and the other way round. |
| `WATCH` | A watched key counts as changed after any write command touches it, even if the value stays the same. |
| `ACL` | One `default` user with every permission (plus `--password`). `ACL SETUSER`/`DELUSER` are refused. |
| `SLOWLOG`, `LATENCY`, `MEMORY` | Answer with empty or placeholder values. |
| Protocol | RESP2 only. `HELLO 3` gets `NOPROTO`, and clients fall back to RESP2. |
| `CONFIG SET` | Accepted and ignored. |

**Not supported:** cluster, sentinel, replication, multiple ACL users, RESP3, client-side caching, keyspace notifications, eviction, modules (RedisJSON, RediSearch, …).

## When not to use it

- **When you need performance.** redis-lite makes no promise about speed or memory use. Use real Redis for benchmarks, load tests and anything performance-sensitive.
- **Production with more than one app node.** Locks, idempotency keys and rate limits are only correct if every node shares one real Redis.
- **Data you need to keep.** A restart loses everything.

## How it works

```
client ──TCP/RESP2──▶ parser ──▶ command table ──▶ in-memory keyspace (16 databases)
                                      │
                                      ├──▶ blocking waiters (BLPOP, BZPOPMIN, XREAD BLOCK …)
                                      ├──▶ pub/sub channels and MONITOR
                                      └──▶ Lua engine (wasmoon) ── redis.call ──┘
```

Commands run one at a time across all connections, the way Redis runs them. This makes every command, `MULTI`/`EXEC` block, Lua script and function call atomic. Keys expire lazily on access, plus a background sweep every 100 ms.

## Development

```bash
npm install
npm test          # Vitest: ioredis + BullMQ end-to-end suites
npm run typecheck
npm run build     # → dist/
```

## License

MIT
