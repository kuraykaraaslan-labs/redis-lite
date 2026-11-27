# Differential testing against a real Redis

`tests/differential/` runs the same command sequences against redis-lite and against a real `redis-server` (the
*oracle*) and compares the raw reply bytes. The oracle is **Redis 7.0.15**, which is also redis-lite's target: a
scenario passes only when both servers send the same bytes.

## Method

- **Scenario.** A scenario is a named list of steps (`s(name, steps, options)` in `differential.harness.ts`). A step
  is one of:
  - a command line, quoted like redis-cli (`'SET k "a b"'`, `"\x00"` escapes);
  - an argv array;
  - a control step: a second connection (`c: 1`), send-without-reading for blocking commands (`wait: false`),
    `read: n`, `blocked: n` (waits until n clients are blocked on each server), `sleep: ms`, or a full SCAN-family
    iteration (`scan`) whose elements are compared as a sorted set.
- **Two runs per scenario.** Every scenario runs once over RESP2 and once over RESP3 (each connection sends `HELLO 3`
  first). Each run goes against a fresh redis-lite (`RedisLite.start({ port: 0 })`) and against the oracle in
  parallel.
- **Comparison.** The transcript (each command and its exact reply bytes) must be identical. `DiffConnection` frames
  replies by parsing RESP, so a slow machine cannot cut a reply short. A missing reply is recorded as `<TIMEOUT>`, a
  closed connection as `<CLOSED>`.
- **Oracle reset between scenarios.** The harness waits until every client of the previous scenario has gone, then
  runs `FLUSHALL`, `SCRIPT FLUSH`, `FUNCTION FLUSH`, `CONFIG RESETSTAT` and `SLOWLOG RESET`. A scenario that sends
  `CONFIG` has every changed parameter reset to its startup value. A scenario marked `fresh: true` (ACL users,
  `DEBUG SET-ACTIVE-EXPIRE`, crashes) restarts the oracle.
- **Hand-written tests.** Suites can add their own tests through the `extra` hook, using `env().pair(proto)`, which
  gives raw connections to the reset oracle and to a fresh redis-lite. Uses:
  - cross-server DUMP/RESTORE: a Redis DUMP restored into redis-lite, a redis-lite DUMP restored into Redis, and a
    comparison of the payload bytes;
  - FUNCTION DUMP/RESTORE;
  - per-section INFO field-name sets;
  - COMMAND DOCS trees;
  - HELP replies.

### Files

| File | Role |
|---|---|
| `differential.oracle.ts` | Locates, starts and stops the oracle |
| `differential.connection.ts` | `DiffConnection`: exact RESP framing; the port guard |
| `differential.resp.ts` | Encoder, redis-cli tokenizer, reply tree |
| `differential.normalizers.ts` | Normalisers, each documented with the reason it exists |
| `differential.harness.ts` | Scenario types, runner, suite registration, mismatch report |
| `differential.probes.ts` | `intProbes`: one scenario per int64 / int32 edge value for an integer argument |
| `tables.differential.test.ts` | Whole-table parity: COMMAND COUNT / LIST, COMMAND INFO and COMMAND DOCS of every 7.0.15 command and subcommand, the `CONFIG GET *` table, the INFO field set |
| `<group>[.<area>].differential.test.ts` | Corpus: one or more suite files per command group, each under 500 lines |

### Running

```
npx vitest run tests/differential                                      # the corpus only
DIFF_REPORT=/some/file.jsonl npx vitest run tests/differential         # also writes one JSON line per mismatch
REDIS_ORACLE_BIN=/path/to/redis-server npx vitest run tests/differential
```

- **Finding the binary.** The oracle binary comes from `REDIS_ORACLE_BIN`. When that is unset, the harness uses
  `/home/kuray/.cache/redis-local/root/usr/bin/redis-server` if it exists. With no binary, every differential suite is
  skipped and the rest of `npx vitest run` is unaffected.
- **Relocated binaries.** For an unpacked (not installed) binary, `LD_LIBRARY_PATH` is set to its `../lib/<triplet>`
  so the dynamic loader finds its shared libraries.

### Safety

- **Its own server only.** Each suite file starts its own oracle on a random free port (asked from the OS), bound to
  `127.0.0.1`. It runs with its own `mkdtemp` directory, `--save ''`, `--appendonly no` and
  `--enable-debug-command yes`.
- **Port 6379 is refused.** `assertSafePort` refuses port 6379 (the developer's own Redis) for every connection and
  every spawn.
- **Shutdown.** The oracle is stopped (SIGTERM, then SIGKILL) and its directory removed in `afterAll`. If the process
  exits without running its hooks, an exit hook does the same. A detached watchdog shell also kills the oracle and
  removes the directory if the test worker is killed.
- **Black box.** The binary is used only as a black box over the network protocol.

### Normalisers

A normaliser applies to one step's reply, identically on both sides. Normalisers exist only for parts of a reply that
Redis does not define:

| Normaliser | Why it is needed |
|---|---|
| `sorted`, `sortedPairs`, `sortedFieldValues`, `sortedDeep`, `sortedConfig`, `commandInfo`, `sortedInfoLines` | Hash-table iteration order: hashtable-encoded sets and hashes, CONFIG GET globs, subcommand tables, the command table in INFO commandstats. Listpack and intset values are ordered and are never sorted. |
| `shape` | Random picks: SPOP, SRANDMEMBER, RANDOMKEY, HRANDFIELD, ZRANDMEMBER; process reports such as the MEMORY MALLOC-STATS allocator dump (bulk and verbatim strings alike). Only the reply types and counts are compared. |
| `anyNumber`, `commandStats`, `keyspaceInfo` | Clocks, memory figures and measured times: TIME, MEMORY USAGE, OBJECT IDLETIME, `usec`, `avg_ttl`. |
| `clientInfo`, `hello`, `digits` | Client ids, addresses, fds, ages, per-client memory, the server version in HELLO. |
| `debugObject` | The pointer and LRU fields of DEBUG OBJECT. |
| `streamIds`, `streamClocks`, `msClock`, `pendingIdle` | Ids generated from the clock (`XADD *`), consumer idle / seen / active times, delivery times. |
| `pubsubChannel` | The channel order of an argument-less UNSUBSCRIBE and of multi-pattern delivery (dictionary order). |
| `infoKeys` | INFO values are process figures. The field names are compared; field-set differences between versions are classified per section in `info.differential.test.ts`. |

Known limitation: the harness keeps a control connection open on the oracle, so `connected_clients` in INFO is one
higher there. `info.differential.test.ts` leaves that one field out of the comparison.

### Target and tags

Until 2026-11-26 redis-lite targeted Redis 8.8 and the oracle was older, so mismatches caused by the version gap were
tagged `v('<what changed>')` and ran as `it.fails`. The target is now **Redis 7.0.15 itself**: everything added after
7.0 was removed from redis-lite (hash field expiration, the time series module, WAITAOF, CLIENT NO-TOUCH / SETINFO,
post-7.0 arguments such as ZRANK WITHSCORE, BITOP DIFF, ZSCAN NOSCORES, XREAD `+`), and every former version difference
was fixed to the 7.0.15 behaviour (command table, HELP texts, CONFIG and INFO tables, encodings, RDB version 10, `%.17g`
doubles, Lua error semantics, XINFO fields, ACL texts, memory figures).

- `v(...)` is now inert (it returns no options) and stays only as a note on what changed after 7.0 where it was left.
- `gap('<why>')` marks a known gap redis-lite cannot close yet; the test runs as `it.fails`, so it fails as soon as the
  gap closes and flags it for review.

## Results (oracle 7.0.15, redis-lite 7.0.15, 2026-11-27)

35 suites, 7177 differential tests (RESP2 and RESP3): all pass except the 6 `gap` tests below. The whole repository
suite (162 files, 8792 tests: unit, end-to-end and differential) passes.

### Known gaps (tagged `gap`)

| Probe | Redis (Lua 5.1) | redis-lite (Lua 5.4) |
|---|---|---|
| `tostring(-0)`, `-0 .. ''`, `cjson.encode(-0)` | `-0` | `0` (5.4 folds the literal `-0` to integer 0) |

Closing these needs a real Lua 5.1 engine; building Lua 5.1 for WASM needs a toolchain download, which has not been
done. Other Lua 5.4 effects no scenario hits: integer overflow wraps instead of losing precision; 5.4-only syntax
(`//`, bitwise operators, `goto`, `<const>`, `\u{}` escapes) compiles instead of failing; hash iteration order and
`math.random` sequences differ.

### Deliberate differences

| Case | Redis 7.0.15 | redis-lite |
|---|---|---|
| A script raises an error table without a string / number `err` field | the server crashes | only that client's connection is closed |
| Busy script inside MULTI / EXEC or inside a C call (sort comparator, gsub callback) | other clients get BUSY | the script cannot yield there, so the server blocks until it ends |

### Not verified by the oracle

- `CONFIG REWRITE`: the oracle runs without a config file.
- Memory figures that depend on the process or on Redis's random hash seed: absolute `used_memory` / `dataset.bytes`
  (compared by delta per data shape), the exact step at which an incremental rehash finishes, skiplist node levels
  (MEMORY USAGE of skiplist zsets differs by a few hundred bytes), client cron buffer shrinking, the Lua heap size.
- XAUTOCLAIM's "Insufficient memory … COUNT too high" threshold is an allocation failure of the oracle's machine,
  modelled as a constant.
- Scenarios left out because they hang or would open connections: SRANDMEMBER / ZRANDMEMBER / HRANDFIELD with a count
  near -2^63 (the oracle builds the reply), REPLICAOF and MIGRATE to arbitrary ports, infinite Lua loops (covered by
  `modules/scripting/tests/scripting.busy.server.test.ts` instead).
