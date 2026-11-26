# Differential testing against a real Redis

`tests/differential/` runs the same command sequences against redis-lite and against a real `redis-server` (the
*oracle*) and compares the raw reply bytes. It found the mismatches listed in
[redis-lite bugs](#a-redis-lite-bugs). Those tests fail on purpose until the bugs are fixed.

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

### Version awareness

The oracle is Redis **7.0.15**; redis-lite targets **8.8** (it reports 8.8.4). Every mismatch was put in one of three
classes:

- **(a) redis-lite bug.** The same behaviour is expected in 7.0 and 8.8. These are plain tests and fail until fixed.
- **(b) version difference.** The feature or text was added or changed after 7.0. The scenario stays in the corpus,
  tagged `v('<what changed>', confidence)`, and runs as `it.fails`. If such a test starts passing, it fails, which
  flags it for review.
- **(c) harness or normaliser issue.** These were fixed during development:
  - deterministic EXPIRETIME instead of TTL;
  - the expiry race in `WATCH on expired key` (active expiry off on both sides);
  - argv-array steps;
  - scenarios removed because they hang a server: an infinite Lua loop in redis-lite, and SRANDMEMBER with a count
    near -2^63 in Redis.

## Results (oracle 7.0.15, redis-lite 8.8.4, 2026-11-26)

**First run:** 213 scenarios + 11 hand-written tests (417 failing tests) were classified as redis-lite bugs, 145 scenarios
as version differences, none left as harness issues.

**After the fix round:** every redis-lite bug found by the first run is fixed. The full suite (unit, end-to-end and
differential) passes: the only failing differential tests are the `it.fails` ones below — version differences, plus
the known gaps listed next, which are tagged the same way but are NOT version differences.

### Known gaps (real differences, tagged `KNOWN GAP` in the suites)

These need a real Lua 5.1 engine; redis-lite runs Lua 5.4 (wasmoon) with a 5.1 compatibility layer. Building Lua 5.1
for WASM needs a toolchain download, which has not been done.

| Probe | Redis (Lua 5.1) | redis-lite (Lua 5.4) |
|---|---|---|
| `tostring(-0)`, `-0 .. ''`, `cjson.encode(-0)` | `-0` | `0` (5.4 folds the literal `-0` to integer 0) |

Other Lua 5.4 effects that no current scenario hits: `10/2 .. ''` gives `5.0`; integer overflow wraps instead of
losing precision; 5.4-only syntax (`//`, bitwise operators, `goto`, `<const>`, `\u{}` escapes) compiles instead of failing;
hash iteration order and `math.random` sequences differ; error texts for string arithmetic omit the variable name.

### Other findings of the first run — status

| Finding | Status |
|---|---|
| Uncaught `WRONGTYPE` when a key a BLPOP/BLMOVE client waits on is overwritten with another type | Fixed: waiters stay blocked or get the error reply exactly like the oracle; `retryBlocked` never throws |
| `EVAL "while true do end"` froze the whole server | Fixed: busy scripts run in Lua threads, yield to the event loop after `busy-reply-threshold`; other clients get `BUSY`, `SCRIPT KILL` / `FUNCTION KILL` / `SHUTDOWN NOSAVE` work, `UNKILLABLE` after a write. Not yieldable inside MULTI/EXEC or inside a C call (sort comparator, gsub callback) |
| `BITFIELD k SET u8 4294967289 1` leaked a JS error | Fixed: Redis's bit-offset error (a JS string cannot hold the 512 MB Redis would allocate) |
| Redis 8.2 / 8.4 features (SET IFEQ, MSETEX, XDELEX, XACKDEL, XADD KEEPREF) | Not implemented yet — the oracle (7.0) cannot verify them either |

## (b) Version differences (expected to fail)

| Reason (what changed after 7.0) | Confidence | Scenarios |
|---|---|---|
| BITCOUNT/BITPOS on a missing key validate their arguments since 7.2 (7.0 replies 0) | medium | bitmaps: BITCOUNT on missing key with bad range |
| BITOP DIFF added in 8.2 | high | bitmaps: BITOP DIFF |
| BITOP DIFF1 added in 8.2 | high | bitmaps: BITOP DIFF1 |
| BITOP ANDOR added in 8.2 | high | bitmaps: BITOP ANDOR |
| BITOP ONE added in 8.2 | high | bitmaps: BITOP ONE |
| BITOP DIFF added in 8.2 (7.0: unknown op syntax error) | medium | bitmaps: BITOP DIFF needs two keys |
| command tips are simple strings in newer Redis (7.0 sends bulk strings); no confirmed version | low | command: COMMAND INFO dbsize; command: COMMAND INFO del; command: COMMAND INFO dump; command: COMMAND INFO exists; … (+25) |
| CONFIG and XINFO subcommands gained request/response policy tips or flags after 7.0 (e.g. CONFIG GET/SET policies) | low | command: COMMAND INFO of container commands (subcommands sorted) |
| blocking commands lost the noscript flag after 7.0 (unverified) | low | command: COMMAND INFO blocking commands flags |
| response_policy:special tip added to SCAN / RANDOMKEY after 7.0 (unverified) | low | command: COMMAND INFO scan and randomkey tips |
| RESP3 COMMAND INFO sends key specs / subcommands as arrays in newer Redis (7.0: sets); no confirmed version | low | command: COMMAND INFO key specs and subcommands in RESP3; command: COMMAND INFO keyless command in RESP3 |
| Redis 8.x has more commands than 7.0 (hash field expiration, vector sets, …) | high | command: COMMAND COUNT |
| command summaries were rewritten and display_text was added to arguments in 7.2 | high | command: COMMAND DOCS of get |
| the HELP footer reads "Print this help." in newer Redis (7.0: "Prints this help.") | medium | command: COMMAND HELP; config: CONFIG HELP; server: OBJECT HELP; server: SLOWLOG HELP |
| 7.2 replies "Invalid number of arguments specified for command" (7.0: the COMMAND\|GETKEYS arity error) | medium | command: COMMAND GETKEYS with a wrong arity for the target |
| 7.2 replies "The command has no key arguments" (7.0: the COMMAND\|GETKEYS arity error) | medium | command: COMMAND GETKEYS of a keyless command |
| set-max-listpack-entries was added in 7.2; 7.0 also lists the *-ziplist-* aliases a glob matches (unverified after 7.0) | low | config: CONFIG GET *max-*-entries* glob |
| maxmemory-samples is bounded to 1..64 in newer Redis (7.0: 1..2147483647); no confirmed version | low | config: CONFIG SET maxmemory-samples out of range |
| CLIENT INFO gained lib-name/lib-ver (7.2), watch (7.4), io-thread (8.0) and tot-net-in/tot-net-out/tot-cmds (8.0) | high | connection: CLIENT INFO fields |
| CLIENT NO-TOUCH was added in 7.2 | high | connection: CLIENT NO-TOUCH on |
| CLIENT SETINFO was added in 7.2 | high | connection: CLIENT SETINFO lib-name |
| CLIENT HELP lists SETINFO and NO-TOUCH (7.2), KILL ID/MAXAGE (7.4) and says "Print this help" | high | connection: CLIENT HELP shape |
| invalid function names were reported with the 'Library names can only contain' text in 7.0; later versions say 'Function names' | low | functions: register_function invalid name text |
| 7.2 prints double replies in shortest round-trip form; 7.0 uses %.17g; the stored double is identical (exact ZCOUNT matches) | high | geo: STOREDIST scores printed in full |
| HSCAN NOVALUES was added in 7.4 | high | hashes: HSCAN NOVALUES on small hash |
| hash field expiration commands (HEXPIRE, HTTL, HPERSIST…) were added in 7.4 | high | hashes-ttl: HEXPIRE NX XX GT LT conditions; hashes-ttl: HEXPIRE numfields mismatch and errors; hashes-ttl: HEXPIRE on a missing key; hashes-ttl: HEXPIRE on present and missing fields; … (+7) |
| HGETDEL / HGETEX / HSETEX were added in 8.0 | high | hashes-ttl: HGETDEL errors; hashes-ttl: HGETDEL removes the returned fields; hashes-ttl: HGETEX errors; hashes-ttl: HGETEX sets and clears field TTL; … (+2) |
| INFO gained the Threads section in 8.0 (io-threads rework) | medium | info: INFO all header order; info: INFO default header order; info: INFO default plus a section; info: INFO everything header order |
| INFO keyspace lines gained subexpiry= in 7.4 (hash field expiration) | high | info: INFO keyspace with expires; info: INFO keyspace with keys and no expires; info: INFO keyspace with several dbs |
| DUMP payload ends with the RDB version: 10 in 7.0, 11 in 7.2, 12 in 7.4+ | high | keys dump: DUMP payload of a string |
| 7.0 rejects RDB version > 10; 7.4+ writes and reads version 12 | high | keys dump: RESTORE payload with a newer RDB version |
| small lists are listpack-encoded since 7.2 (quicklist in 7.0) | high | keys object: OBJECT ENCODING list small |
| lists under list-max-listpack-size are listpack since 7.2 (quicklist in 7.0) | high | keys object: OBJECT ENCODING list of short items |
| small non-integer sets are listpack-encoded since 7.2 (hashtable in 7.0) | high | keys object: OBJECT ENCODING set with strings |
| non-integer small sets are listpack since 7.2 | high | keys object: OBJECT ENCODING set out of int64 range |
| an intset over set-max-intset-entries becomes listpack since 7.2 (hashtable in 7.0) | high | keys object: OBJECT ENCODING set-max-intset-entries |
| the HELP footer line reads "Print this help." after 7.0 (7.0: "Prints this help.") | low | keys object: OBJECT HELP |
| 7.2 range-checks RANK to -LONG_MAX..LONG_MAX (LLONG_MIN negation overflow fix); 7.0 accepts it | low | lists: LPOS RANK of the minimum integer |
| lists encoded as plain listpack (OBJECT ENCODING listpack) since 7.2; 7.0 always says quicklist | high | lists: long list encoding; lists: small list encoding |
| XINFO CONSUMERS gained the inactive field in 7.2 | high | resp3: XINFO CONSUMERS is an array of maps; streams.groups: XINFO CONSUMERS; streams.groups: XINFO CONSUMERS inactive field; streams.groups: XREADGROUP creates consumer |
| ACL users list the sanitize-payload flag in newer Redis (7.0 does not show it); version unconfirmed | medium | resp3: ACL GETUSER is a map; server: ACL GETUSER default; server: ACL LIST of the default user; server: ACL SETUSER creates a user; … (+2) |
| MEMORY STATS gained fields after 7.0 | medium | resp3: MEMORY STATS is a map |
| command summaries were rewritten in 7.2 | high | resp3: COMMAND DOCS is a map |
| doubles are printed in their shortest round-trip form since 7.2 (fpconv); 7.0 uses %.17g (0.10000000000000001) | medium | resp3: EVAL with setresp(3) returns a double; resp3: ZSCORE double formatting |
| ZRANK / ZREVRANK WITHSCORE was added in 7.2 | high | resp3: ZRANK WITHSCORE |
| LOLWUT prints the server version (7.0.15 vs 8.x) | high | resp3: LOLWUT is a verbatim string |
| errors raised by redis.call reach Lua pcall as {err=...} tables instead of strings after 7.0 | low | scripting: Lua pcall around arity error; scripting: Lua pcall around redis.call |
| error objects raised as tables keep their err field through Lua pcall after 7.0 (7.0.15 shows a non-table) | low | scripting: Lua pcall around error() with table |
| Redis 7.0.15 crashes (connection closed) on error() with a table lacking err; fixed after 7.0 | medium | scripting: error() with table without err field |
| script errors for unknown commands / wrong arity use the regular command error text since 7.2 (shared command checks) | medium | scripting: unknown command from script; scripting: unknown command from script via pcall; scripting: wrong arity from script; scripting: wrong arity from script via pcall |
| the os table (os.clock only) became available to scripts after 7.0 (8.0) | medium | scripting: Lua os table |
| double replies use the shortest round-trip representation (fpconv) since 7.2 instead of %.17g | medium | scripting: Lua double return formatting |
| small lists are listpack-encoded since 7.2 (quicklist before) | high | server: OBJECT ENCODING of a small list |
| small non-integer sets are listpack-encoded since 7.2 (hashtable before) | high | server: OBJECT ENCODING of a small string set |
| an intset that outgrows set-max-intset-entries becomes listpack since 7.2 (hashtable before) | high | server: OBJECT ENCODING of an intset past set-max-intset-entries |
| set-max-listpack-entries was added in 7.2 | high | server: OBJECT ENCODING of a set past both limits |
| MEMORY STATS gained fields after 7.0 (e.g. overhead.db.hashtable.lut, db.dict.rehashing.count in 7.4) | medium | server: MEMORY STATS shape |
| small lists are listpack-encoded since 7.2, so DEBUG OBJECT has no ql_* fields | high | server: DEBUG OBJECT of a small list |
| the banner ends with the server version (7.0.15 vs 8.x); the blank line 7.0 prints after the art is gone in redis-lite (unverified) | low | server: LOLWUT VERSION 5 banner |
| LOLWUT prints the server version (7.0.15 vs 8.x) and 8.x has its own art | high | server: LOLWUT default output |
| WAITAOF was added in 7.2 | high | server: WAITAOF without appendonly |
| Redis 8 bundles RedisTimeSeries, which registers the @timeseries ACL category | medium | server: ACL CAT lists categories |
| ACL users list the sanitize-payload flag in newer Redis (7.0 does not show it); version unconfirmed; ACL rules are kept as written (7.0 rewrote -@dangerous into the minimal -sort_ro -keys form) | low | server: ACL SETUSER with categories and channels |
| NOPERM errors name the user since 7.2 ("User alice has no permissions to run…") | high | server: NOPERM for a denied command |
| NOPERM errors name the user since 7.2 ("User alice has no permissions to access…") | high | server: NOPERM for a denied key |
| ACL DRYRUN denial texts name the user since 7.2 | medium | server: ACL DRYRUN |
| ACL LOG entries gained entry-id, timestamp-created and timestamp-last-updated in 7.2 | high | server: ACL LOG records a denied command |
| small non-integer sets are listpack-encoded since 7.2; 7.0 uses hashtable | high | sets: CONFIG set-max-intset-entries lowers the limit; sets: intset converts on a string member; sets: removing the string member keeps the encoding; sets: small string set encoding |
| error text names the command as 'xread' (quoted, lower case) instead of XREAD after 7.0 | low | streams: XREAD unbalanced streams text |
| XREAD + (last entry) added in 7.4 | high | streams: XREAD plus id last entry |
| XGROUP CREATE with $ reports entries-read = entries-added instead of nil (changed after 7.0) | medium | streams.groups: XGROUP CREATE dollar sets entries-read |
| XINFO STREAM FULL consumers gained active-time in 7.2 | high | streams.groups: XINFO STREAM FULL COUNT limits PEL; streams.groups: XINFO STREAM FULL with groups |
| 7.2 switched double replies to the shortest round-trip form (fpconv); 7.0 prints %.17g (1.1000000000000001) | high | zsets: ZSCORE shortest round trip |
| ZRANK / ZREVRANK WITHSCORE were added in 7.2 (an extra argument is a syntax error since, an arity error before) | high | zsets: ZRANK WITHSCORE |
| ZSCAN NOSCORES was added in 8.0 | high | zsets-ops: ZSCAN NOSCORES |
