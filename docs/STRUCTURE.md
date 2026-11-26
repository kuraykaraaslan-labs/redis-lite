# Code structure

How redis-lite's source is laid out and the conventions every change follows. The layout applies the owner's code
structure rules (module-first, `libs/` for infrastructure, Zod DTOs, static services, messages files) to a protocol
server, with the adaptations listed in [Adaptations](#adaptations-for-a-protocol-server).

Status: every module follows the layout and the recipe below (`modules/strings` is the worked example). The
deliberate exceptions are listed in [Stateful components](#stateful-components-the-exception-to-static-services-only)
and [Public surface of a module](#public-surface-of-a-module).

## Layout

```
index.ts, cli.ts         package entry points (RedisLite API, redis-lite CLI): bootstrap only
libs/                    thin infrastructure, no Redis semantics of its own
  app-error.ts           AppError: an error reply (`-ERR …`) thrown by services
  env.ts                 option and environment schemas; the only file that reads process.env
  logger/                Logger: structured JSON lines on stderr
  message-format/        formatMessage(): fills `{placeholders}` of message templates
  schemas/               reusable Zod primitives, one per concept: KeySchema, SubcommandSchema, IntegerSchema(With),
                         Int64Schema, FloatSchema(With), ExpireTimeSchema(s), BlockTimeoutSchema, ScanCursorSchema,
                         ScanOptionsSchema, and the option-loop helpers parseArg / Parsed<T> / reject / firstIssue
    tests/               unit tests of the primitives (no server)
  resp/                  RESP2/RESP3 codec (reply.ts types, encoder.ts, parser.ts) and reply types; messages.ts = error texts shared by several modules or
                         by the libs/schemas primitives (protocol errors included)
  number/, glob/         pure Redis number recognition/formatting and int64 arithmetic (addInt64; no error replies),
                         Redis glob matching; number/tests/ = unit tests
modules/<module>/        one folder per command group or subsystem (see the mapping below)
  tests/                 the module's tests
tests/                   cross-module end-to-end suites (smoke, BullMQ, RESP3, protocol, binary safety…) + helpers.ts
bench/                   throughput benchmark
```

`@/` is the project root: every import that leaves a module uses it (`@/libs/...`, `@/modules/...`, `@/tests/...`);
relative paths only inside one module. It is configured in `tsconfig.json` (`paths`), `vitest.config.ts` (alias) and
the build (`tsc-alias`, see [Build](#build)).

### Module → path mapping

Every module has a facade `<module>.service.ts` (static methods bound from its sub-services) and, when it has error
texts, `<module>.messages.ts`. The table lists the rest.

| Module | Commands, DTOs, sub-services | Other files | Was |
|---|---|---|---|
| `command` | sub-services `lookup` (metadata table, arity), `keys` (key specs), `reply` (COMMAND INFO / DOCS, HELP), `blocking` (Block replies) | `command.types.ts` (CommandSpec, CommandContext, CommandMeta), `command.handler.ts` (withDTO, validated, keysAt, bySubcommand, Block, NO_REPLY; re-exported by the facade), `command.registry.ts` (COMMANDS: every module's table), `command.meta_table.ts` (metadata data table), `command.enums.ts` | `src/commands/{types,index,meta,meta-table,blocking}.ts` |
| `server` | `server.commands.ts`, `server.dto.ts`; sub-services `info`, `config`, `command`, `acl`, `diagnostics`, `memory`, `debug`, `admin`, `lolwut` | runtime (stateful): `server.core.ts` (RedisLiteServer), `server.client.ts`, `server.config.ts`, `server.dispatcher.ts`, `server.connections.ts`, `server.access.ts`, `server.blocking.ts`, `server.keyspace.ts`, `server.watch.ts` (ServerWatches / WatchedKeys: who WATCHes which key), `server.pubsub.ts`, `server.observer.ts`, `server.memory_model.ts`, `server.files.ts`, `server.settings.ts` (startup / CONFIG SET side effects, DEBUG RELOAD / LOADAOF hooks); `server.conf_file.ts` (redis.conf reader), `server.constants.ts`, `server.types.ts`, `server.enums.ts` | `src/server/{server,client,config,conf-file}.ts`, `src/commands/server.ts` |
| `connection` | `connection.commands.ts`, `connection.dto.ts`; sub-services `session` (PING, ECHO, SELECT, RESET, QUIT…), `auth` (AUTH, HELLO), `client` (the caller's own CLIENT settings, tracking), `admin` (CLIENT INFO / LIST / KILL / UNBLOCK…) | `connection.types.ts`, `connection.enums.ts` | `src/commands/connection.ts` |
| `database` | sub-services `encoding` (OBJECT ENCODING, listpack sizes), `scan` (cursor pages) | `database.core.ts` (Database: keyspace, expiry; stateful), `database.sampler.ts`, `database.types.ts` | `src/store/{database,encoding,scan}.ts` |
| `keys` | `keys.commands.ts`, `keys.extra.commands.ts` (SORT, MOVE, SWAPDB, DUMP, RESTORE), `keys.dto.ts`; sub-services `space` (DEL, EXISTS, RENAME, COPY, KEYS, SCAN…), `expire`, `object`, `database` (MOVE, SWAPDB), `sort`, `dump` (DUMP / RESTORE) | `keys.enums.ts` | `src/commands/keys.ts`, `keys-extra.ts` |
| `strings` | the [worked example](#the-module-recipe-worked-example-modulesstrings) (also owns LCS and SUBSTR) | | `src/commands/strings.ts` (+ LCS / SUBSTR from `bitmaps.ts`) |
| `bitmaps` | sub-services `bit` (GETBIT, SETBIT, BITCOUNT, BITPOS), `op` (BITOP), `field` (BITFIELD) | `bitmaps.structure.ts`, `bitmaps.types.ts`, `bitmaps.enums.ts` | `src/commands/bitmaps.ts` |
| `hashes` | sub-services `field` (HSET, HGET…), `getset` (HGETDEL, HGETEX, HSETEX), `iteration` (HSCAN, HRANDFIELD), `ttl` (HEXPIRE / HTTL families, HPERSIST) | `hashes.structure.ts` (HashStore: field TTLs), `hashes.types.ts`, `hashes.enums.ts` | `src/commands/hashes.ts` |
| `lists` | sub-services `push`, `index`, `move` (incl. blocking pops) | `lists.structure.ts`, `lists.deque.structure.ts` (ring-buffer deque behind every list value, tracks listpack bytes), `lists.types.ts`, `lists.enums.ts` | `src/commands/lists.ts` |
| `sets` | sub-services `member`, `random` (SPOP, SRANDMEMBER), `algebra` (SUNION, SINTER, SDIFF, SINTERCARD), `scan` (SSCAN) | `sets.structure.ts`, `sets.enums.ts` | `src/commands/sets.ts` |
| `zsets` | sub-services `write`, `query`, `range`, `pop`, `combine` | `zsets.structure.ts` (sorted set), `zsets.types.ts`, `zsets.enums.ts` | `src/commands/zsets.ts`, `src/store/zset.ts` |
| `streams` | sub-services `append`, `range`, `read`, `group`, `pending`, `info` | `streams.structure.ts` (stream, ids), `streams.types.ts`, `streams.enums.ts` | `src/commands/streams.ts`, `src/store/stream.ts` |
| `timeseries` | time series (TS.*, the Redis 8 module type `TSDB-TYPE`): sub-services `ingest` (TS.CREATE, ADD, MADD, INCRBY / DECRBY, DEL), `range` (TS.GET, RANGE, REVRANGE), `query` (TS.MGET, MRANGE, MREVRANGE, QUERYINDEX), `rules` (TS.CREATERULE, DELETERULE, the RENAME hook, ts-compaction-policy), `info` (TS.INFO, ALTER) | `timeseries.structure.ts` (series, chunks), shared helpers the sub-services use: `timeseries.store.ts` (keyspace, ingestion, compaction, LATEST), `timeseries.aggregator.ts` (aggregators, buckets), `timeseries.reply.ts` (RESP2 / RESP3 shapes), `timeseries.index.ts` (the label index of FILTER queries: selection, the `keyChanged` Database hook, self-validation against the keyspace) over `timeseries.index.structure.ts` (LabelIndex postings; one per server, `server.labelIndex`); `.types.ts`, `.enums.ts` | (new) |
| `hyperloglog` | sub-services `value` (PFADD, PFCOUNT, PFMERGE), `debug` (PFDEBUG, PFSELFTEST) | `hyperloglog.structure.ts`, `.encoding.ts`, `.estimator.ts`, `.hash.ts` (the HLL algorithm, split by concern), `.types.ts`, `.enums.ts` | `src/commands/hyperloglog.ts`, `src/store/hll.ts` |
| `geo` | sub-services `point` (GEOADD, GEOPOS, GEODIST, GEOHASH), `search` | `geo.geohash.ts`, `geo.types.ts`, `geo.enums.ts` | `src/commands/geo.ts` |
| `pubsub` | `pubsub.service.ts` (single service) | | `src/commands/pubsub.ts` |
| `transactions` | sub-services `queue` (MULTI, DISCARD), `watch` (WATCH, UNWATCH), `exec` (EXEC) | | `src/commands/transactions.ts` |
| `scripting` | `scripting.commands.ts` (EVAL, SCRIPT), `scripting.functions.commands.ts` (FUNCTION, FCALL), `scripting.dto.ts`; sub-services `scripts`, `functions` | Lua engine (stateful): `scripting.engine.ts` (LuaEngine) and its parts `scripting.{bridge,convert,library,stack}.engine.ts`; `scripting.prelude.ts` + `prelude/*.prelude.ts` (Lua source); `scripting.types.ts`, `scripting.enums.ts` | `src/commands/{scripting,functions}.ts`, `src/lua/*` |
| `acl` | `acl.dto.ts`; sub-services `check` (permission checks, denial texts), `rules` (ACL rules, passwords, GENPASS), `log` (ACL LOG) | `acl.engine.ts` (Acl: users + ACL LOG; stateful), `acl.structure.ts` (AclUser, AclSelector), `acl.types.ts`, `acl.enums.ts` (owner of `AclCategoryEnum`) | `src/server/acl.ts` |
| `persistence` | sub-services `rdb`, `dump` (DUMP / RESTORE payloads), `aof`, `manifest`, `files`, `propagate`; codecs `*.codec.ts` (bytes / CRC / LZF, listpack, object encoder / decoder, module types, RDB I/O); `persistence_*.rules.ts` (propagation rules per type) | runtime (stateful): `persistence.core.ts` (Persistence) built as layers `persistence.state.ts` → `.snapshot.ts` → `.aof_writer.ts` → `.aof_loader.ts`; `persistence.propagator.ts` (Propagator); `persistence.types.ts`, `persistence.enums.ts` | `src/server/{persistence,propagate}.ts`, `src/store/rdb.ts` |
| `memory` | sub-services `usage` (per key: MEMORY USAGE, DEBUG OBJECT), `overhead` (dataset, used_memory, maxmemory), `info` (MEMORY STATS, INFO memory); size models `*.model.ts` (allocator, object, quicklist, rax) | `memory.tracker.ts` (MemoryTracker) and `memory.eviction.ts` (Evictor) (stateful), `memory.types.ts`, `memory.enums.ts` | `src/store/memory.ts`, `src/server/{memory-tracker,eviction}.ts` |
| `notifications` | sub-services `events` (which keyspace events a command fires), `publish` (flags, channel messages) | `notifications.types.ts` | `src/server/notifications.ts` |
| `replication` | `replication.commands.ts` (REPLICAOF, SLAVEOF, PSYNC, SYNC, REPLCONF, FAILOVER), `replication.dto.ts`; sub-services `role` (REPLICAOF, ROLE), `sync` (PSYNC, SYNC, REPLCONF), `failover` (FAILOVER) | runtime (stateful): `replication.core.ts` (Replication) built as layers `replication.state.ts` → `.primary.ts` (master side: attaching replicas, the stream, acks, WAIT) → `.replica.ts` (replica side: REPLICAOF, loading, applying the stream) → `.core.ts` (cron, FAILOVER, ROLE / INFO); `replication.link.ts` (ReplicaLink: the connection to the master and the handshake), `replication.stream.ts` (reader of the link), `replication.backlog.structure.ts`; `.types.ts`, `.enums.ts`. ROLE, WAIT and WAITAOF stay routed by `server` (their DTOs are pinned there) and call the runtime | (new) |
| `tracking` | `tracking.dto.ts` (CLIENT TRACKING / CACHING grammar, exposed as `TrackingService.TrackingOptionsSchema` / `CachingValueSchema`); sub-services `client`, `invalidation` | `tracking.core.ts` (Tracking: the invalidation table; stateful), `tracking.types.ts`, `tracking.enums.ts` | `src/server/tracking.ts` |

Why these are modules and not libs: `libs/` holds code with no Redis behaviour of its own (a codec, a logger, number
parsing). Anything that implements Redis semantics (the dispatcher's checks, ACL rules, persistence formats, eviction
policies) is domain logic and lives in a module, even when it has no commands of its own. The **RESP codec** is in
`libs/resp`: it is a wire format every module and the server depend on, and it has no knowledge of commands. Eviction
lives in `memory` because it is the maxmemory half of memory accounting.

File type suffixes: `.service.ts`, `.dto.ts`, `.types.ts`, `.enums.ts`, `.messages.ts`, `.commands.ts` follow the
recipe below. Other suffixes name what a file is: `.structure.ts` (a data structure), `.core.ts` (a module's stateful
runtime class), `.engine.ts` / `.prelude.ts` (the Lua engine and its Lua source), `.codec.ts` (binary formats),
`.model.ts` (memory size models), `.rules.ts` (propagation rules); the server runtime files are named after their part
(`server.dispatcher.ts`, `server.client.ts`…).

### Public surface of a module

Another module may import only:

- the facade `<module>.service.ts` (the default-export class, plus what it re-exports: the commands-layer toolkit from
  `command.handler`, and the stateful classes `Acl` / `AclUser`, `Database`, `Tracking`, `Evictor`, `MemoryTracker`,
  `Persistence`, `Propagator`, `Replication`);
- the module's `.types.ts`, `.enums.ts`, `.structure.ts` and `.messages.ts` files (a shared constant such as
  `MemoryMessages.OOM` is read where it is owned, not copied).

Never another module's sub-services, DTOs, commands files or internals: a facade gains a method when a caller needs one.
Primitives several modules need go to `@/libs/schemas` instead. Documented exceptions (1–2 and 4 are forced by load order
(a value re-export through the facade would close an import cycle and leave a facade `undefined` while the command
tables are built; 3 only clarifies how the replication runtime is wired):

1. **`command.registry.ts`** is the composition root of the command table: it imports every module's commands file,
   and the dispatcher (`server.dispatcher`, `server.access`, `server.blocking`) and the Lua bridge
   (`scripting.bridge.engine`, for `redis.call`) read `COMMANDS` from it.
2. **The server runtime** (`server.core`, `server.client`, `server.config`, `server.conf_file`) is built by the entry
   points (`index.ts`, `cli.ts`) and by tests that start a bare server. Other modules use these classes as types only,
   through `export type` re-exports of `server.service.ts`.
3. **The replication runtime** reaches the server through `ctx.server.replication` / the RedisLiteServer methods it
   needs (`attachClient`, `runAsMaster`, `releaseBlocked`, `pauseWrites`, `killClient`); the dispatcher and the client
   read `replication.messages` / `replication.types` (READONLY, MASTERDOWN, NOREPLICAS; `ReplicaInfo`), which the
   public-surface rule already allows. `server.core` constructs `Replication` from the facade's re-export, like
   `Persistence`.
4. **`LuaEngine`** is constructed by `server.core` from `scripting.engine.ts`; `scripting.service.ts` re-exports it as a
   type only (the engine reaches the command registry through `redis.call`).

## The module recipe (worked example: `modules/strings`)

```
modules/strings/
  strings.commands.ts          routing: CommandSpec table → DTO → service. No logic.
  strings.dto.ts               Zod DTOs for every command's arguments + z.infer input types
  strings.service.ts           facade: static methods bound from the sub-services
  strings.value.service.ts     GET, SET and variants, GETEX, MGET, MSET, MSETNX
  strings.counter.service.ts   INCR, DECR, INCRBY, DECRBY, INCRBYFLOAT
  strings.range.service.ts     APPEND, STRLEN, GETRANGE, SUBSTR, SETRANGE
  strings.lcs.service.ts       LCS
  strings.messages.ts          the module's own error texts
  strings.enums.ts             Zod enums (SetConditionEnum, LcsFlagEnum)
  strings.types.ts             domain types (LcsMatchRange)
  tests/strings.<sub>.service.test.ts   one suite per sub-service, end to end through ioredis
  tests/strings.dto.test.ts             unit tests of the argument grammar
```

### 1. Commands layer: `<module>.commands.ts`

Each entry keeps the command's name, arity, flags and keys and routes `args` (the arguments after the command name) to
the service. The usual handler is `withDTO(Dto, Service.method)`: it `safeParse`s the arguments and either returns the
validation error reply or calls the service with the typed input.

```ts
{ name: 'set', arity: -3, flags: WRITE, keys: keysAt(0), handler: withDTO(SetDTO, StringsService.set) },
```

**Error precedence.** Redis sometimes inspects the key *before* the arguments (GETRANGE answers WRONGTYPE even when an
index is not an integer). Then the handler is *read → parse → act*: call the service's read step, then `validated()`,
then the service with the value already read. Keep the comment saying why:

```ts
{
  name: 'getrange',
  arity: 4,
  // read first: WRONGTYPE beats a non-integer index
  handler: (ctx, args) => {
    const value = StringsService.get(ctx, { key: args[0] });
    return validated(GetRangeDTO, args, (input) => StringsService.getRange(value, input));
  },
},
```

How to find the order: it is whatever the current code does (the tests pin it). Read the old handler top to bottom and
note which line touches the database first.

### 2. DTOs: `<module>.dto.ts`

- One `…DTO` per command (aliases are fine: `export const GetDelDTO = KeyDTO;`), grouped by sub-service with
  `// ====` dividers, `z.infer` types at the bottom.
- A DTO parses the `args` array: `z.tuple([KeySchema, Int64Schema])` for fixed shapes, `z.tuple([...], z.string())`
  for a rest, and `.transform()` to a named object (`{ key, delta }`). Arity is already checked by the dispatcher.
- Build from `@/libs/schemas` primitives; their messages are Redis's texts (`ERR value is not an integer or out of
  range`, `ERR value is not a valid float`, `ERR invalid expire time in '<cmd>' command`).
- Order is precedence: tuple items are checked in argument order and only the first issue is reported (Redis reports
  the first problem it meets). Option lists (`SET … NX GET EX 10`) are read left to right inside a `.transform()`,
  failing with `reject(ctx, message)` where the token stands, and cross-option conflicts are checked after the loop,
  exactly like the original code.
- DTOs are stateless: no `ctx`, no database. Anything that needs the database (WRONGTYPE, the stored value not being an
  integer, proto-max-bulk-len from the config) stays in the service.
- Build schemas once at module level (`const SET_EXPIRE = ExpireTimeSchemas('set')`), never per call.
- A primitive goes to `libs/schemas` once a second module needs it; until then it stays in the module DTO, named by the
  value (`OffsetSchema`), not the command. One primitive per concept: a command-worded integer is
  `IntegerSchemaWith(Messages.X)`, never a local copy.
- Option loops that parse several arguments use `parseArg(schema, raw)` → `Parsed<T>` (`{ ok, value } | { ok, error }`)
  and `reject(ctx, error)` from `@/libs/schemas`.

### 3. Services: `<module>.service.ts` and `<module>.<sub>.service.ts`

- `export default class XService` with only `static` methods, explicit return types on public methods, private
  constants as `static readonly`, class sections *Constants → Private Helpers → Public Methods*. (Per-server state
  lives in [stateful components](#stateful-components-the-exception-to-static-services-only), never in a service.)
- Signature: `(ctx: CommandContext, input: XInput)`; read-first methods also take the value read
  (`getRange(value, input)`).
- Split into sub-services past ~150 lines or 3+ concerns. The facade binds them
  (`static get = StringsValueService.get.bind(StringsValueService)`); sub-services never import each other; other
  modules import only the facade.
- Errors: `throw new AppError(Messages.X)`. Never a literal string. Validation errors are never thrown (they are DTO
  issues).
- Side-effect flags stay explicit: `ctx.noop = true` when a write command ends up changing nothing (SET NX on an
  existing key).

### 4. Messages: `<module>.messages.ts`

Const object (final prose, word for word as Redis sends it), named + default export:

```ts
export const StringsMessages = {
  DECREMENT_OVERFLOW: 'ERR decrement would overflow',
  OFFSET_OUT_OF_RANGE: 'ERR offset is out of range',
} as const;
export default StringsMessages;
```

Texts used by several modules or by the `@/libs/schemas` primitives (`ERR syntax error`, WRONGTYPE, overflow, the
blocking-timeout and SCAN-cursor errors, protocol errors…) live in `@/libs/resp/messages` (`RespMessages`); everything
else is owned by one module's messages file. Lua source in `scripting.prelude` / `prelude/*.prelude.ts` raises its
own error texts inside Lua and is not subject to this rule. A text that embeds values is a template filled with `formatMessage`:
`formatMessage(RespMessages.WRONG_ARITY, { command: 'mset' })`.

### 5. Tests: `modules/<module>/tests/`

- One suite per source file, named after it (`strings.range.service.test.ts` ↔ `strings.range.service.ts`); split tests
  when you split a source file.
- End to end through a real server: `const t = useServer();` from `@/tests/helpers`, which also provides `err`, `arity`,
  `WRONGTYPE`, `SYNTAX`, `NOT_INT`, `NOT_FLOAT` and `resp3Client`. Expected texts are written out, never imported from
  messages files: the tests are the oracle.
- DTO unit tests (`<module>.dto.test.ts`) for grammar and precedence corner cases.
- A suite that waits a fixed time for background work (eviction cycles) goes in `TIMING_SENSITIVE` in
  `vitest.config.ts`: that project runs after all other suites, so CPU contention cannot make it flaky.

## Conventions

- **Imports**: six groups separated by blank lines: Node built-ins, framework (vitest), external packages, `@/libs`,
  other `@/` (modules, index, tests), module-local relative. `import type` for type-only imports.
- **Quotes**: single quotes; double quotes only for a string that contains an apostrophe.
- **Dividers**: `// ====` file sections in files over ~60 lines; `// ────` class sections.
- **File size**: at most 500 lines for logic-bearing files, split by responsibility (DTO, types, enums and messages files
  are exempt).
- **Naming**: snake_case module folders, `<module>.<sub>.<type>.ts` files, PascalCase classes, UPPER_SNAKE constants.

## Adaptations for a protocol server

These deviate from the HTTP-oriented rules on purpose:

1. **AppError carries the full Redis error text, no HTTP status.** `throw new AppError('ERR …')`: the prefix (`ERR`,
   `WRONGTYPE`, `NOSCRIPT`, `BUSYGROUP`…) is the error class clients see. The dispatcher (`server.core.ts`) turns an
   AppError into an error reply; any other exception is logged as an internal error and answered `ERR <message>`.
2. **Messages are Pattern B const objects of final prose** (Redis's exact texts), with `{placeholder}` templates filled
   by `formatMessage` from `@/libs/message-format`.
3. **Validation errors are returned, not thrown.** The commands layer answers a failed `safeParse` with the first issue
   as an error reply (`validationErrorReply`). The dispatcher treats a returned error reply exactly like a thrown one
   (no keys touched, counted as a failed call).
4. **DTOs cover the stateless grammar only, and Redis's error precedence wins over "validate first".** See
   [read → parse → act](#1-commands-layer-modulecommandsts).
5. **Logger without winston.** `libs/logger` is a static class (`error/warn/info/debug(message, context)`) writing one
   JSON line per entry to stderr, keeping the package free of logging dependencies. Messages are static
   `[Class.method] Text`; variable data goes in `context`. The threshold is the server's `logLevel` (set when a server
   starts; with several servers in one process the last one started wins).
6. **`process.env` only in `libs/env.ts`.**

## Stateful components: the exception to "static services only"

Services are static and stateless. A Redis server, however, owns state that lives as long as the server and exists
once per server (tests start several servers in one process, so module-level singletons are not an option). That
state is held by a few classes, each created by `server.core` (RedisLiteServer) and reachable from every command as
`ctx.server.<x>`. They are the only `new`-able classes besides AppError, the reply types and the data structures:

| Component | File | Why it is an object |
|---|---|---|
| Server runtime | `server.core.ts` (RedisLiteServer) with its parts `server.dispatcher`, `.connections`, `.access`, `.blocking`, `.keyspace`, `.pubsub`, `.observer`, `.memory_model`, `.files`; `server.client.ts` (one Client per connection); `server.config.ts` (ServerConfig) | sockets, connected clients, blocked clients, pub/sub subscriptions, stats and config of one server |
| Database | `database.core.ts` | one keyspace per logical database (`databases` config): values, expiries, LRU/LFU data, change listeners |
| Lua engine | `scripting.engine.ts` (LuaEngine) | one Lua state per server: loaded scripts, function libraries, the running script |
| ACL | `acl.engine.ts` (Acl), `acl.structure.ts` (AclUser) | the server's users and its ACL LOG |
| Tracking | `tracking.core.ts` (Tracking) | the invalidation table, BCAST prefixes, deferred messages; all its operations are TrackingService methods taking it as first argument |
| Persistence | `persistence.core.ts` (Persistence, layered over `.state` / `.snapshot` / `.aof_writer` / `.aof_loader`), `persistence.propagator.ts` (Propagator) | open AOF files, rewrite and save state, fsync timers; the current propagation unit |
| Memory | `memory.tracker.ts` (MemoryTracker), `memory.eviction.ts` (Evictor) | incremental used-memory accounting and the eviction pool / background pass |
| Replication | `replication.core.ts` (Replication, layered over `.state` / `.primary` / `.replica`), `replication.link.ts` (ReplicaLink), `replication.stream.ts` (ReplicationStreamReader) | role, replication IDs and offsets, the backlog, attached replicas, the link to a master and its parser, WAIT waiters, the FAILOVER state |
| Time series label index | `timeseries.index.structure.ts` (LabelIndex, held as `server.labelIndex`) | the FILTER postings of every database; each Database's change hook (built in `server.core`) calls `TimeseriesService.keyChanged` |

Rules for them: the logic that does not need the state stays in the module's static services (a component delegates
to them, e.g. Tracking → TrackingService, Persistence → PersistenceService); a component file follows the same import,
quote, divider and 500-line rules; other modules reach the class through the module's facade (see the exceptions in
[Public surface of a module](#public-surface-of-a-module)).

## Open notes

- Three `sdssplitargs` implementations exist (`RespParser.splitArgs` in `libs/resp` for inline requests,
  `PersistenceService.splitArgs` for the AOF manifest and redis.conf, a private one in `acl.rules.service` for ACL
  rules). They differ in corner cases (NUL bytes, which whitespace counts) that the tests pin, so they were not merged.
- Parsing through Zod costs some throughput on hot commands (after step 1: SET and GET within noise, INCR about
  15–20 % slower in a pipelined check). Measure with `bench/` when touching hot DTOs.

## Build

`npm run build` = `tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json`. TypeScript does not rewrite
`paths`, so `tsc-alias` rewrites `@/…` in `dist/**/*.js` and `.d.ts` to relative paths, as the rules prescribe.

`tsconfig.json` keeps `moduleResolution: NodeNext` and declares `paths` without `baseUrl`: TypeScript 7 removed
`baseUrl` and `moduleResolution: node`, which the rules' tsconfig snippet still shows.
