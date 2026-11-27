# @kuraykaraaslan/redis-lite: Phases

> **What:** an npm package that behaves exactly like Redis, written in TypeScript. Apps change nothing except `REDIS_URL`.
> **Reference:** Redis Open Source **7.0.15** (retargeted from 8.8 on 2026-11-26). Every reply, error text, encoding and binary format (RDB, HLL, RESP2/RESP3) must match it, and nothing added after 7.0 is offered.
> **Scope:** everything Redis 7.0.15 has: single-node Redis, persistence, replication, sentinel and cluster. Redis 7.0 bundles no modules.
> **Only exception:** performance. JavaScript cannot match Redis's speed, so no throughput or latency commitment is made (see the README).

---

## Method

- **Clean room:** Redis is used only as a black-box reference to compare against. None of its source code is copied.
- **Differential tests:** every test script runs against the reference Redis and against redis-lite, and the raw RESP bytes must be equal. "Same as Redis" means this test passes.
- **Representative values in the same way as Redis:** `MEMORY USAGE`, `INFO memory`, `OBJECT ENCODING`/`IDLETIME`/`FREQ` and `DEBUG OBJECT` are computed the way Redis computes them: the same encodings (listpack, intset, quicklist, skiplist, hashtable), the same encoding-conversion thresholds and the same allocator size classes (jemalloc). The numbers come from the same formulas, not from random constants.

---

## Status (2026-11-26)

| Done | |
|---|---|
| Single-node core | all 240 commands of Redis 7.0.15 (command table identical to `COMMAND INFO` / `COMMAND DOCS`), Lua, Functions, streams, geo, bitmaps |
| Clients | ioredis 5.8, BullMQ 5.66 and 6.7 tested end to end |
| Reference | A real Redis 7.0.15 binary is the differential oracle (see docs/DIFFERENTIAL.md) |

---

## Phase A: exact single-node semantics

- `DUMP`/`RESTORE` and `FUNCTION DUMP`/`RESTORE` in the real RDB format (RDB version, CRC64 Jones checksum, LZF), interchangeable with Redis.
- HyperLogLog with Redis's algorithm and byte format (sparse and dense `HYLL` representation, `PFDEBUG`, `PFSELFTEST`).
- `SCAN`/`HSCAN`/`SSCAN`/`ZSCAN` with real cursors and pages (`COUNT` honoured).
- Streams stored as Redis stores them: nodes of `stream-node-max-entries`, so `MAXLEN ~` / `MINID ~` trim whole nodes exactly as Redis does.
- `WATCH` is triggered only by real modifications (Redis's `signalModifiedKey` rules).
- Object encodings and conversion thresholds (`*-max-listpack-entries`, `*-max-listpack-value`, `set-max-intset-entries`, …) → `OBJECT ENCODING` matches Redis.
- Memory accounting the way Redis does it → `MEMORY USAGE`, `MEMORY STATS`, `INFO memory`.
- LRU/LFU clocks per key → `OBJECT IDLETIME`, `OBJECT FREQ`.
- `DEBUG` subcommands (`OBJECT`, `SLEEP`, `RELOAD`, `SET-ACTIVE-EXPIRE`, `CHANGE-REPL-ID`, …).

## Phase B: protocol, config and observability

- RESP3 (`HELLO 3`): maps, sets, doubles, big numbers, push messages, attribute replies, all with Redis's per-command reply types.
- `CONFIG GET`/`SET`/`REWRITE`/`RESETSTAT` with the full config table, and settings that really take effect. Config file loading (`redis-lite /path/redis.conf`).
- Keyspace notifications (`notify-keyspace-events`).
- Client-side caching: `CLIENT TRACKING` (default, broadcast, OPTIN/OPTOUT, redirect), `CLIENT CACHING`, invalidation messages.
- `SLOWLOG` and `LATENCY` that record real events; `COMMAND DOCS` and full `COMMAND INFO` metadata (key specs, ACL categories, tips).
- Full ACL: users, passwords, selectors, command/key/channel permissions, `ACL LOG`, ACL file.
- `CLIENT` complete: `PAUSE`, `NO-EVICT`, `REPLY OFF/SKIP`, `KILL` filters, output buffer limits.

## Phase C: persistence and memory limits

- RDB snapshots: `SAVE`, `BGSAVE`, `save` points, loading at startup, `DEBUG RELOAD`.
- AOF: `appendonly`, multi-part AOF with manifest, `BGREWRITEAOF`, `appendfsync`, loading.
- `maxmemory` with every eviction policy (`allkeys-lru/lfu/random`, `volatile-*`, `noeviction`), using Redis's sampling approach.

## Phase D: replication

- `REPLICAOF`, `PSYNC` with full sync over RDB and partial resync from the backlog, `WAIT`, `ROLE`, `INFO replication`, `REPLCONF`, read-only replicas.
- Works with real Redis as master or replica.

## Phase E: sentinel

- `redis-lite --sentinel`: monitoring, quorum, subjective and objective down, leader election, failover, `SENTINEL` commands, client discovery (`SENTINEL GET-MASTER-ADDR-BY-NAME`).
- Works with ioredis `sentinels` option (next-boilerplate's `REDIS_SENTINELS` path).

## Phase F: cluster

- `cluster-enabled`: 16384 slots, CRC16 hash tags, `MOVED`/`ASK`, `CLUSTER` commands, cluster bus (gossip, failure detection, failover), resharding with `MIGRATE`/`ASKING`, `redis-lite --cluster create` style tooling.
- Works with ioredis `Cluster` and `redis-cli --cluster`.

Each phase ends when its differential test suite matches the reference Redis byte for byte.
