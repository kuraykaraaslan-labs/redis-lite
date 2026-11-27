import ServerAclService from './server.acl.service';
import ServerAdminService from './server.admin.service';
import ServerCommandService from './server.command.service';
import ServerConfigService from './server.config.service';
import ServerDebugService from './server.debug.service';
import ServerDiagnosticsService from './server.diagnostics.service';
import ServerInfoService from './server.info.service';
import ServerLolwutService from './server.lolwut.service';
import ServerMemoryService from './server.memory.service';
import { REDIS_VERSION } from './server.constants';

export {
  ServerAclService,
  ServerAdminService,
  ServerCommandService,
  ServerConfigService,
  ServerDebugService,
  ServerDiagnosticsService,
  ServerInfoService,
  ServerLolwutService,
  ServerMemoryService,
};
/** The server runtime, as types: other modules hold these objects (the runtime itself is built by the entry points). */
export type { Client } from './server.client';
export type { ServerConfig } from './server.config';
export type { RedisLiteServer } from './server.core';

/** The server commands' public API: one flat facade over the sub-services (other modules import only this class). */
export default class ServerService {
  /** The Redis version redis-lite reports (HELLO, INFO, LOLWUT). */
  static readonly REDIS_VERSION = REDIS_VERSION;

  // Info — INFO
  static info = ServerInfoService.info.bind(ServerInfoService);

  // Config — CONFIG GET / SET / RESETSTAT / REWRITE / HELP
  static configGet = ServerConfigService.get.bind(ServerConfigService);
  static configSet = ServerConfigService.set.bind(ServerConfigService);
  static configResetStat = ServerConfigService.resetStat.bind(ServerConfigService);
  static configRewrite = ServerConfigService.rewrite.bind(ServerConfigService);
  static configHelp = ServerConfigService.help.bind(ServerConfigService);

  // Command — COMMAND and its subcommands
  static commandAll = ServerCommandService.all.bind(ServerCommandService);
  static commandCount = ServerCommandService.count.bind(ServerCommandService);
  static commandList = ServerCommandService.list.bind(ServerCommandService);
  static commandInfo = ServerCommandService.info.bind(ServerCommandService);
  static commandDocs = ServerCommandService.docs.bind(ServerCommandService);
  static commandGetKeys = ServerCommandService.getKeys.bind(ServerCommandService);
  static commandHelp = ServerCommandService.help.bind(ServerCommandService);

  // ACL — users, the ACL file, inspection
  static aclSetUser = ServerAclService.setUser.bind(ServerAclService);
  static aclDelUser = ServerAclService.delUser.bind(ServerAclService);
  static aclGetUser = ServerAclService.getUser.bind(ServerAclService);
  static aclList = ServerAclService.list.bind(ServerAclService);
  static aclUsers = ServerAclService.users.bind(ServerAclService);
  static aclWhoAmI = ServerAclService.whoAmI.bind(ServerAclService);
  static aclFile = ServerAclService.aclFile.bind(ServerAclService);
  static aclLoad = ServerAclService.load.bind(ServerAclService);
  static aclSave = ServerAclService.save.bind(ServerAclService);
  static aclCat = ServerAclService.cat.bind(ServerAclService);
  static aclLog = ServerAclService.log.bind(ServerAclService);
  static aclDryRun = ServerAclService.dryRun.bind(ServerAclService);
  static aclGenPass = ServerAclService.genPass.bind(ServerAclService);
  static aclHelp = ServerAclService.help.bind(ServerAclService);

  // Diagnostics — SLOWLOG, LATENCY
  static slowlogGet = ServerDiagnosticsService.slowlogGet.bind(ServerDiagnosticsService);
  static slowlogLen = ServerDiagnosticsService.slowlogLen.bind(ServerDiagnosticsService);
  static slowlogReset = ServerDiagnosticsService.slowlogReset.bind(ServerDiagnosticsService);
  static slowlogHelp = ServerDiagnosticsService.slowlogHelp.bind(ServerDiagnosticsService);
  static latencyLatest = ServerDiagnosticsService.latencyLatest.bind(ServerDiagnosticsService);
  static latencyHistory = ServerDiagnosticsService.latencyHistory.bind(ServerDiagnosticsService);
  static latencyReset = ServerDiagnosticsService.latencyReset.bind(ServerDiagnosticsService);
  static latencyGraph = ServerDiagnosticsService.latencyGraph.bind(ServerDiagnosticsService);
  static latencyHistogram = ServerDiagnosticsService.latencyHistogram.bind(ServerDiagnosticsService);
  static latencyDoctor = ServerDiagnosticsService.latencyDoctor.bind(ServerDiagnosticsService);
  static latencyHelp = ServerDiagnosticsService.latencyHelp.bind(ServerDiagnosticsService);

  // Memory — MEMORY
  static memoryUsage = ServerMemoryService.usage.bind(ServerMemoryService);
  static memoryDoctor = ServerMemoryService.doctor.bind(ServerMemoryService);
  static memoryStats = ServerMemoryService.stats.bind(ServerMemoryService);
  static memoryMallocStats = ServerMemoryService.mallocStats.bind(ServerMemoryService);
  static memoryPurge = ServerMemoryService.purge.bind(ServerMemoryService);
  static memoryHelp = ServerMemoryService.help.bind(ServerMemoryService);

  // Debug — DEBUG
  static debugObject = ServerDebugService.object.bind(ServerDebugService);
  static debugListpack = ServerDebugService.listpack.bind(ServerDebugService);
  static debugHtstats = ServerDebugService.htstats.bind(ServerDebugService);
  static debugHtstatsKey = ServerDebugService.htstatsKey.bind(ServerDebugService);
  static debugQuicklist = ServerDebugService.quicklist.bind(ServerDebugService);
  static debugHelp = ServerDebugService.help.bind(ServerDebugService);
  static debugSleep = ServerDebugService.sleep.bind(ServerDebugService);
  static debugSetActiveExpire = ServerDebugService.setActiveExpire.bind(ServerDebugService);
  static debugChangeReplId = ServerDebugService.changeReplId.bind(ServerDebugService);
  static debugPopulate = ServerDebugService.populate.bind(ServerDebugService);
  static debugLog = ServerDebugService.log.bind(ServerDebugService);
  static debugReload = ServerDebugService.reload.bind(ServerDebugService);
  static debugLoadAof = ServerDebugService.loadAof.bind(ServerDebugService);
  static debugStringMatchLen = ServerDebugService.stringMatchLen.bind(ServerDebugService);
  static debugAccepted = ServerDebugService.accepted.bind(ServerDebugService);

  // Admin — TIME, DBSIZE, ROLE, MODULE, FLUSH*, MONITOR, SAVE / BGSAVE / BGREWRITEAOF / LASTSAVE, SHUTDOWN, WAIT
  static time = ServerAdminService.time.bind(ServerAdminService);
  static dbSize = ServerAdminService.dbSize.bind(ServerAdminService);
  static role = ServerAdminService.role.bind(ServerAdminService);
  static moduleList = ServerAdminService.moduleList.bind(ServerAdminService);
  static moduleHelp = ServerAdminService.moduleHelp.bind(ServerAdminService);
  static moduleNotAllowed = ServerAdminService.moduleNotAllowed.bind(ServerAdminService);
  static flush = ServerAdminService.flush.bind(ServerAdminService);
  static monitor = ServerAdminService.monitor.bind(ServerAdminService);
  static save = ServerAdminService.save.bind(ServerAdminService);
  static bgsave = ServerAdminService.bgsave.bind(ServerAdminService);
  static bgrewriteaof = ServerAdminService.bgrewriteaof.bind(ServerAdminService);
  static lastsave = ServerAdminService.lastsave.bind(ServerAdminService);
  static shutdown = ServerAdminService.shutdown.bind(ServerAdminService);
  static wait = ServerAdminService.wait.bind(ServerAdminService);

  // LOLWUT
  static lolwut = ServerLolwutService.lolwut.bind(ServerLolwutService);
}
