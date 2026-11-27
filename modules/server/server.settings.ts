import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';
import type { Reply } from '@/libs/resp';

import { Acl } from '@/modules/acl/acl.service';
import CommandService from '@/modules/command/command.service';
import { Database } from '@/modules/database/database.service';

import { ServerConfig } from './server.config';
import type { RedisLiteServer } from './server.core';
import { ServerFiles } from './server.files';
import ServerMessages from './server.messages';

/** Configs that change how the memory model sizes existing keys. */
const MEMORY_MODEL_CONFIGS = /max-listpack|max-intset|max-ziplist|stream-node|list-compress/;

/**
 * Config side effects and the DEBUG hooks the server wires to its subsystems: startup values (constructor `config`,
 * redis.conf) validated like CONFIG SET, what a CONFIG SET changes beyond the stored value, DEBUG RELOAD / LOADAOF.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 */
export class ServerSettings {
  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** A startup config value: validated like CONFIG SET, then applied. */
  init(name: string, value: string): void {
    const config = this.server.config;
    if (!config.has(name)) throw new Error(formatMessage(ServerMessages.BAD_DIRECTIVE, { name }));
    const r = config.validate(name, value);
    if ('error' in r) throw new Error(formatMessage(ServerMessages.INVALID_VALUE, { name, error: r.error }));
    let v = r.value;
    if (ServerConfig.canonical(name) === 'dir') v = ServerFiles.checkDir(v);
    config.set(name, v);
    this.apply(name, v);
  }

  /** CONFIG SET side effects. Startup values are applied while the server is still being built. */
  apply(name: string, value: string): void {
    const server = this.server;
    const canonical = ServerConfig.canonical(name);
    // the memory model may not exist yet while the constructor applies startup configs
    if (MEMORY_MODEL_CONFIGS.test(canonical)) server.memoryModel?.tracker.invalidateAll();
    switch (canonical) {
      case 'maxmemory':
        // lowering maxmemory evicts right away
        if (server.evictor && Number(value) > 0) server.evictor.perform();
        break;
      case 'maxmemory-policy':
        server.evictor?.clearPool();
        break;
      case 'requirepass':
        server.acl.setRequirePass(value);
        break;
      case 'acllog-max-len':
        server.acl.logMaxLen = Number(value);
        break;
      case 'port':
        server.rebind(Number(value));
        break;
      case 'bind':
        if (server.options) server.rebind(server.options.port, ServerSettings.bindHost(value));
        break;
      case 'acl-pubsub-default':
        server.acl.pubsubDefault = value === 'allchannels' ? 'allchannels' : 'resetchannels';
        break;
      default:
        server.replication?.onConfigChange(canonical);
    }
  }

  /** The address redis-lite listens on for a `bind` list: its first entry (`*` any IPv4, `::*` any IPv6, `-` optional). */
  static bindHost(value: string): string {
    const first = (value.split(' ').find(Boolean) ?? '*').replace(/^-/, '');
    return first === '*' ? '0.0.0.0' : first === '::*' ? '::' : first;
  }

  /** Wires DEBUG RELOAD and DEBUG LOADAOF to the persistence runtime. */
  installDebugHooks(): void {
    const server = this.server;
    server.debugHooks.reload = (_client, args) => this.debugReload(args);
    server.debugHooks.loadaof = () => {
      const reply = server.persistence.debugLoadAof();
      server.evictor.clearPool();
      return reply;
    };
  }

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** DEBUG RELOAD [MERGE] [NOFLUSH] [NOSAVE]: save, flush and load the RDB again. */
  private debugReload(args: string[]): Reply {
    const opts = { merge: false, noflush: false, nosave: false };
    for (const a of args) {
      const o = a.toLowerCase();
      if (o === 'merge') opts.merge = true;
      else if (o === 'noflush') opts.noflush = true;
      else if (o === 'nosave') opts.nosave = true;
      else throw new AppError(ServerMessages.DEBUG_RELOAD_OPTIONS);
    }
    const reply = this.server.persistence.debugReload(opts);
    this.server.evictor.clearPool();
    return reply;
  }

  /** The logical databases, wired to the keyspace (expiry) and the memory tracker. */
  buildDatabases(count: number): Database[] {
    const server = this.server;
    return Array.from({ length: count }, (_, i) => {
      const db: Database = new Database(
        (key) => server.keyspace.onExpired(i, key),
        server.config,
        (key) => server.memoryModel.tracker.changed(i, key),
        server.keyExpiry,
      );
      return db;
    });
  }

  /** The ACL engine, built from the command metadata and the startup configuration. */
  buildAcl(requirepass: string): Acl {
    const config = this.server.config;
    return new Acl({
      allCommands: () => CommandService.allCommandsDeep().map((m) => m.fullname),
      categoriesOf: (name) => (CommandService.getCommandMeta(name)?.acl ?? []).map((c) => `@${c}`),
      requirepass,
      pubsubDefault: config.get('acl-pubsub-default') === 'allchannels' ? 'allchannels' : 'resetchannels',
      logMaxLen: config.num('acllog-max-len'),
    });
  }
}
