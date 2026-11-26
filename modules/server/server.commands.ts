import { AppError } from '@/libs/app-error';
import { unknownSubcommand } from '@/libs/resp/messages';

import CommandService, { bySubcommand, validated, withDTO } from '@/modules/command/command.service';
import type { CommandHandler, CommandSpec } from '@/modules/command/command.types';

import {
  AclCatDTO,
  AclDelUserDTO,
  AclDryRunDTO,
  AclGenPassDTO,
  AclGetUserDTO,
  AclLogDTO,
  AclNoArgsDTO,
  AclSetUserDTO,
  BgsaveDTO,
  CommandGetKeysDTO,
  CommandListDTO,
  CommandNamesDTO,
  ConfigGetDTO,
  ConfigSetDTO,
  DebugActiveExpireDTO,
  DebugListpackDTO,
  DebugNoArgsDTO,
  DebugObjectDTO,
  DebugOneArgDTO,
  DebugPackedThresholdDTO,
  DebugPopulateDTO,
  DebugQuicklistDTO,
  DebugReloadDTO,
  DebugSleepDTO,
  FlushDTO,
  InfoDTO,
  LatencyEventDTO,
  LolwutDTO,
  MemoryNoArgsDTO,
  MemoryUsageDTO,
  ShutdownDTO,
  SlowlogGetDTO,
  WaitAofDTO,
  WaitDTO,
} from './server.dto';
import ServerService from './server.service';

/**
 * Routing of the server commands: name, arity, flags, then DTO → service. Container commands route on their
 * subcommand; their DTOs check each subcommand's argument count (a mismatch is Redis's subcommand syntax error).
 */

// ============================================================================
// Fallbacks
// ============================================================================

/** Unknown subcommand (the dispatcher answers it first for subcommands it knows of; kept for direct calls). */
function unknown(command: string): CommandHandler {
  return (_ctx, args) => {
    throw new AppError(unknownSubcommand(args[0], command));
  };
}

/** Redis addReplySubcommandSyntaxError(): the container's answer to any subcommand it does not route. */
function syntaxError(command: string): CommandHandler {
  return (_ctx, args) => {
    throw new AppError(CommandService.subcommandSyntaxMessage(args[0], command));
  };
}

// ============================================================================
// Containers
// ============================================================================

const config = bySubcommand(
  {
    get: withDTO(ConfigGetDTO, ServerService.configGet),
    set: withDTO(ConfigSetDTO, ServerService.configSet),
    resetstat: (ctx) => ServerService.configResetStat(ctx),
    rewrite: () => ServerService.configRewrite(),
    help: () => ServerService.configHelp(),
  },
  unknown('config'),
);

const commandSubcommands = bySubcommand(
  {
    count: () => ServerService.commandCount(),
    list: withDTO(CommandListDTO, ServerService.commandList),
    info: withDTO(CommandNamesDTO, ServerService.commandInfo),
    docs: withDTO(CommandNamesDTO, ServerService.commandDocs),
    getkeys: (_ctx, args) => validated(CommandGetKeysDTO, args, (input) => ServerService.commandGetKeys(input, false)),
    getkeysandflags: (_ctx, args) => validated(CommandGetKeysDTO, args, (input) => ServerService.commandGetKeys(input, true)),
    help: () => ServerService.commandHelp(),
  },
  unknown('command'),
);

const acl = bySubcommand(
  {
    setuser: withDTO(AclSetUserDTO, ServerService.aclSetUser),
    deluser: withDTO(AclDelUserDTO, ServerService.aclDelUser),
    getuser: withDTO(AclGetUserDTO, ServerService.aclGetUser),
    list: withDTO(AclNoArgsDTO, (ctx) => ServerService.aclList(ctx)),
    users: withDTO(AclNoArgsDTO, (ctx) => ServerService.aclUsers(ctx)),
    whoami: withDTO(AclNoArgsDTO, (ctx) => ServerService.aclWhoAmI(ctx)),
    // read first: a missing ACL file beats a wrong argument count
    load: (ctx, args) => {
      const aclfile = ServerService.aclFile(ctx);
      return validated(AclNoArgsDTO, args, () => ServerService.aclLoad(ctx, aclfile));
    },
    save: (ctx, args) => {
      const aclfile = ServerService.aclFile(ctx);
      return validated(AclNoArgsDTO, args, () => ServerService.aclSave(ctx, aclfile));
    },
    cat: withDTO(AclCatDTO, ServerService.aclCat),
    log: withDTO(AclLogDTO, ServerService.aclLog),
    dryrun: withDTO(AclDryRunDTO, ServerService.aclDryRun),
    genpass: withDTO(AclGenPassDTO, ServerService.aclGenPass),
    help: withDTO(AclNoArgsDTO, () => ServerService.aclHelp()),
  },
  syntaxError('acl'),
);

const slowlog = bySubcommand(
  {
    get: withDTO(SlowlogGetDTO, ServerService.slowlogGet),
    len: (ctx) => ServerService.slowlogLen(ctx),
    reset: (ctx) => ServerService.slowlogReset(ctx),
    help: () => ServerService.slowlogHelp(),
  },
  unknown('slowlog'),
);

const latency = bySubcommand(
  {
    latest: () => ServerService.latencySamples(),
    history: () => ServerService.latencySamples(),
    reset: () => ServerService.latencyReset(),
    graph: withDTO(LatencyEventDTO, ServerService.latencyGraph),
    histogram: () => ServerService.latencyHistogram(),
    doctor: (ctx) => ServerService.latencyDoctor(ctx),
    help: () => ServerService.latencyHelp(),
  },
  unknown('latency'),
);

const memory = bySubcommand(
  {
    usage: withDTO(MemoryUsageDTO, ServerService.memoryUsage),
    doctor: withDTO(MemoryNoArgsDTO, (ctx) => ServerService.memoryDoctor(ctx)),
    stats: withDTO(MemoryNoArgsDTO, (ctx) => ServerService.memoryStats(ctx)),
    'malloc-stats': withDTO(MemoryNoArgsDTO, () => ServerService.memoryMallocStats()),
    purge: withDTO(MemoryNoArgsDTO, () => ServerService.memoryPurge()),
    help: withDTO(MemoryNoArgsDTO, () => ServerService.memoryHelp()),
  },
  syntaxError('memory'),
);

const debug = bySubcommand(
  {
    help: withDTO(DebugNoArgsDTO, () => ServerService.debugHelp()),
    object: withDTO(DebugObjectDTO, ServerService.debugObject),
    sleep: withDTO(DebugSleepDTO, ServerService.debugSleep),
    'set-active-expire': withDTO(DebugActiveExpireDTO, ServerService.debugSetActiveExpire),
    'change-repl-id': withDTO(DebugNoArgsDTO, (ctx) => ServerService.debugChangeReplId(ctx)),
    'quicklist-packed-threshold': withDTO(DebugPackedThresholdDTO, () => ServerService.debugAccepted()),
    listpack: withDTO(DebugListpackDTO, ServerService.debugListpack),
    quicklist: withDTO(DebugQuicklistDTO, ServerService.debugQuicklist),
    'stringmatch-len': withDTO(DebugNoArgsDTO, () => ServerService.debugStringMatchLen()),
    populate: withDTO(DebugPopulateDTO, ServerService.debugPopulate),
    log: withDTO(DebugOneArgDTO, ServerService.debugLog),
    reload: withDTO(DebugReloadDTO, ServerService.debugReload),
    loadaof: withDTO(DebugNoArgsDTO, (ctx) => ServerService.debugLoadAof(ctx)),
    'set-disable-deny-scripts': withDTO(DebugOneArgDTO, () => ServerService.debugAccepted()),
    'set-skip-checksum-validation': withDTO(DebugOneArgDTO, () => ServerService.debugAccepted()),
    'pause-cron': withDTO(DebugOneArgDTO, () => ServerService.debugAccepted()),
    'dict-resizing': withDTO(DebugOneArgDTO, () => ServerService.debugAccepted()),
  },
  syntaxError('debug'),
);

// ============================================================================
// Commands
// ============================================================================

const NOSCRIPT = { noscript: true } as const;

export const serverCommands: CommandSpec[] = [
  { name: 'info', arity: -1, handler: withDTO(InfoDTO, ServerService.info) },
  { name: 'config', arity: -2, flags: NOSCRIPT, handler: config },
  { name: 'time', arity: 1, handler: () => ServerService.time() },
  { name: 'dbsize', arity: 1, handler: (ctx) => ServerService.dbSize(ctx) },
  { name: 'flushdb', arity: -1, flags: { write: true }, handler: withDTO(FlushDTO, (ctx) => ServerService.flush(ctx, false)) },
  { name: 'flushall', arity: -1, flags: { write: true }, handler: withDTO(FlushDTO, (ctx) => ServerService.flush(ctx, true)) },
  { name: 'command', arity: -1, handler: (ctx, args) => (args.length ? commandSubcommands(ctx, args) : ServerService.commandAll()) },
  { name: 'acl', arity: -2, handler: acl },
  { name: 'slowlog', arity: -2, handler: slowlog },
  { name: 'latency', arity: -2, handler: latency },
  { name: 'monitor', arity: 1, flags: NOSCRIPT, handler: (ctx) => ServerService.monitor(ctx) },
  { name: 'shutdown', arity: -1, flags: NOSCRIPT, handler: withDTO(ShutdownDTO, ServerService.shutdown) },
  { name: 'waitaof', arity: 4, flags: NOSCRIPT, handler: withDTO(WaitAofDTO, ServerService.waitAof) },
  { name: 'lolwut', arity: -1, handler: withDTO(LolwutDTO, ServerService.lolwut) },
  { name: 'save', arity: 1, flags: NOSCRIPT, handler: (ctx) => ServerService.save(ctx) },
  { name: 'bgsave', arity: -1, flags: NOSCRIPT, handler: withDTO(BgsaveDTO, ServerService.bgsave) },
  { name: 'bgrewriteaof', arity: 1, flags: NOSCRIPT, handler: (ctx) => ServerService.bgrewriteaof(ctx) },
  { name: 'lastsave', arity: 1, handler: (ctx) => ServerService.lastsave(ctx) },
  { name: 'wait', arity: 3, flags: NOSCRIPT, handler: withDTO(WaitDTO, ServerService.wait) },
  { name: 'role', arity: 1, handler: (ctx) => ServerService.role(ctx) },
  { name: 'memory', arity: -2, handler: memory },
  { name: 'debug', arity: -2, flags: NOSCRIPT, handler: debug },
];
