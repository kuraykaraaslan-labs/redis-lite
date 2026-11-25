# Code structure

How redis-lite's source is laid out and the conventions every change follows. The layout applies the owner's code
structure rules (module-first, `libs/` for infrastructure, Zod DTOs, static services, messages files) to a protocol
server, with the adaptations listed in [Adaptations](#adaptations-for-a-protocol-server).

Status: **step 1 is done**: the tree is in the target layout, `libs/` and the core are in place and `modules/strings` is
converted as the reference. **Step 2** converts the other modules with the [checklist](#step-2-checklist).

## Layout

```
index.ts, cli.ts         package entry points (RedisLite API, redis-lite CLI): bootstrap only
libs/                    thin infrastructure, no Redis semantics of its own
  app-error.ts           AppError: an error reply (`-ERR …`) thrown by services
  env.ts                 option and environment schemas; the only file that reads process.env
  logger/                Logger: structured JSON lines on stderr
  message-format/        formatMessage(): fills `{placeholders}` of message templates
  schemas/               reusable Zod primitives (KeySchema, Int64Schema, FloatSchema, ExpireTimeSchema…)
  resp/                  RESP2/RESP3 codec and reply types; messages.ts = error texts shared by several modules
  number/, glob/         Redis number parsing/formatting, Redis glob matching
modules/<module>/        one folder per command group or subsystem (see the mapping below)
  tests/                 the module's tests
tests/                   cross-module end-to-end suites (smoke, BullMQ, RESP3, protocol, binary safety…) + helpers.ts
bench/                   throughput benchmark
```

`@/` is the project root: every import that leaves a module uses it (`@/libs/...`, `@/modules/...`, `@/tests/...`);
relative paths only inside one module. It is configured in `tsconfig.json` (`paths`), `vitest.config.ts` (alias) and
the build (`tsc-alias`, see [Build](#build)).

### Module → path mapping

| Module | Files | Was |
|---|---|---|
| `command` | `command.types.ts` (CommandSpec, CommandContext), `command.handler.ts` (Block, NO_REPLY, keysAt, `withDTO` / `validated`), `command.registry.ts` (COMMANDS), `command.meta.ts` + `command.meta_table.ts` (COMMAND metadata, key specs), `command.blocking.ts` | `src/commands/{types,index,meta,meta-table,blocking}.ts` |
| `server` | `server.core.ts` (RedisLiteServer: sockets, dispatcher), `server.client.ts`, `server.config.ts`, `server.conf_file.ts`, `server.commands.ts` (INFO, CONFIG, DEBUG, COMMAND, ACL, SLOWLOG, MEMORY, WAIT…) | `src/server/{server,client,config,conf-file}.ts`, `src/commands/server.ts` |
| `connection` | `connection.commands.ts` (PING, AUTH, HELLO, SELECT, CLIENT, RESET…) | `src/commands/connection.ts` |
| `database` | `database.core.ts` (keyspace, expiry), `database.encoding.ts`, `database.scan.ts` | `src/store/{database,encoding,scan}.ts` |
| `keys` | `keys.commands.ts`, `keys.extra.commands.ts` (SORT, MOVE, SWAPDB, DUMP, RESTORE) | `src/commands/keys.ts`, `keys-extra.ts` |
| `strings` | converted, see [the recipe](#the-module-recipe-worked-example-modulesstrings) (now also owns LCS and SUBSTR, Redis's `string` group) | `src/commands/strings.ts` (+ LCS / SUBSTR from `bitmaps.ts`) |
| `bitmaps`, `hashes`, `lists`, `sets`, `geo`, `pubsub`, `transactions` | `<module>.commands.ts` | `src/commands/<name>.ts` |
| `zsets`, `streams`, `hyperloglog` | `<module>.commands.ts` + `<module>.structure.ts` (sorted set, stream, HLL data structures) | `src/commands/*.ts`, `src/store/{zset,stream,hll}.ts` |
| `scripting` | `scripting.commands.ts` (EVAL, SCRIPT), `scripting.functions.commands.ts` (FUNCTION, FCALL), `scripting.engine.ts` (Lua engine), `scripting.prelude.ts` | `src/commands/{scripting,functions}.ts`, `src/lua/*` |
| `acl` | `acl.core.ts` (users, rules, ACL LOG, ACL file) | `src/server/acl.ts` |
| `persistence` | `persistence.core.ts` (RDB/AOF lifecycle), `persistence.rdb.ts` (format), `persistence.propagate.ts` (AOF propagation) | `src/server/{persistence,propagate}.ts`, `src/store/rdb.ts` |
| `memory` | `memory.accounting.ts` (Redis-style sizes), `memory.tracker.ts`, `memory.eviction.ts` (maxmemory policies) | `src/store/memory.ts`, `src/server/{memory-tracker,eviction}.ts` |
| `notifications` | `notifications.core.ts` (keyspace events) | `src/server/notifications.ts` |
| `tracking` | `tracking.core.ts` (client-side caching) | `src/server/tracking.ts` |

Why these are modules and not libs: `libs/` holds code with no Redis behaviour of its own (a codec, a logger, number
parsing). Anything that implements Redis semantics (the dispatcher's checks, ACL rules, persistence formats, eviction
policies) is domain logic and lives in a module, even when it has no commands of its own. The **RESP codec** is in
`libs/resp`: it is a wire format every module and the server depend on, and it has no knowledge of commands. Eviction
lives in `memory` because it is the maxmemory half of memory accounting.

File type suffixes: `.service.ts`, `.dto.ts`, `.types.ts`, `.enums.ts`, `.messages.ts`, `.commands.ts` follow the
recipe below. Step-1 files that are not converted yet keep a descriptive suffix: `.core.ts` (the module's central
runtime class), `.structure.ts` (a data structure), `.engine.ts` / `.prelude.ts` (Lua), `.accounting.ts`, `.tracker.ts`,
`.eviction.ts`, `.rdb.ts`, `.propagate.ts`, `.client.ts`, `.config.ts`. Step 2 decides per file whether it becomes a
sub-service or stays a stateful component.

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
  value (`OffsetSchema`), not the command.

### 3. Services: `<module>.service.ts` and `<module>.<sub>.service.ts`

- `export default class XService` with only `static` methods, explicit return types on public methods, private
  constants as `static readonly`, class sections *Constants → Private Helpers → Public Methods*.
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

Texts used by several modules (`ERR syntax error`, WRONGTYPE, overflow…) live in `@/libs/resp/messages`
(`RespMessages`). A text that embeds values is a template filled with `formatMessage`:
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

## Build

`npm run build` = `tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json`. TypeScript does not rewrite
`paths`, so `tsc-alias` rewrites `@/…` in `dist/**/*.js` and `.d.ts` to relative paths, as the rules prescribe.

`tsconfig.json` keeps `moduleResolution: NodeNext` and declares `paths` without `baseUrl`: TypeScript 7 removed
`baseUrl` and `moduleResolution: node`, which the rules' tsconfig snippet still shows.

## Step 2 checklist

For each module (`connection`, `keys`, `bitmaps`, `hashes`, `lists`, `sets`, `zsets`, `streams`, `hyperloglog`, `geo`,
`pubsub`, `transactions`, `scripting`, `server`) and then the subsystems (`command`, `database`, `acl`, `persistence`,
`memory`, `notifications`, `tracking`):

1. Run `npx vitest run modules/<module>` and keep it green after every step; never edit an assertion.
2. Read each handler and note its **error precedence**: which argument checks come before the first database access.
3. Write `<module>.messages.ts` with every module-specific error text (move single-module entries out of
   `@/libs/resp/messages`, keep shared ones there). Templates for texts with values.
4. Write `<module>.dto.ts`: one DTO per command, from `@/libs/schemas` primitives; add a primitive to `libs/schemas`
   when a second module needs it.
5. Write the service(s): static class, typed inputs, `AppError` + messages, no literal strings. Split past ~150 lines or
   3+ concerns; facade with `.bind()`.
6. Rewrite `<module>.commands.ts` as routing only (`withDTO`, or read → `validated` → act with a comment).
7. Replace `CommandError` with `AppError` in the module.
8. Logs: `Logger.<level>('[Class.method] Static text', { …context })`.
9. Split `tests/<module>.commands.test.ts` along the service split; add `<module>.dto.test.ts` for grammar corners.
10. Keep files ≤ 500 lines, imports in six groups, single quotes, dividers; `npx tsc --noEmit`, `npx vitest run` and
    `npm run build` green.
11. Cross-module calls go through the other module's facade; replace imports of another module's internals as that
    module gets a facade.

### Known debt left by step 1

- `CommandError` is a deprecated alias of `AppError` (`@/libs/app-error`) still used by the unconverted modules; delete
  it once the last use is gone.
- `@/libs/resp/messages` still holds single-module texts (streams, zsets, scripting, transactions, connection…).
- The throwing parsers in `@/libs/number` (`parseInteger`, `parseInt64`, `parseFloatArg`) are still used for argument
  parsing by unconverted modules; after step 2 they should only parse stored values.
- Cross-module imports of non-facade internals (e.g. `hashes.commands` helpers used by `server.core`, `persistence.core`
  and `keys.extra.commands`).
- Files over 500 lines (see the step-1 report): `persistence.rdb.ts`, `persistence.core.ts`, `server.core.ts`,
  `acl.core.ts`, `server.commands.ts`, `memory.accounting.ts`, `command.meta_table.ts` (a data table),
  `streams.commands.ts`, `scripting.prelude.ts`, `scripting.engine.ts`, `persistence.propagate.ts`, `zsets.commands.ts`,
  `hyperloglog.structure.ts`, and several test suites that split along with their modules.
- Parsing through Zod costs some throughput on hot commands (quick pipelined check after step 1: SET and GET within
  noise, INCR about 15–20 % slower). Measure with `bench/` when converting hot modules.
