import { AppError } from '@/libs/app-error';
import { matchGlob } from '@/libs/glob';
import { formatMessage } from '@/libs/message-format';
import { OK, RespMap } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';

import { ServerConfig } from './server.config';
import type { ConfigGetInput, ConfigSetInput } from './server.dto';
import { ServerFiles } from './server.files';
import ServerMessages from './server.messages';

/** CONFIG: GET (exact names and glob patterns), SET (all-or-nothing, with side effects), RESETSTAT, REWRITE. */
export default class ServerConfigService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static setFailed(name: string, reason: string): AppError {
    return new AppError(formatMessage(ServerMessages.CONFIG_SET_FAILED, { name, reason }));
  }

  /**
   * The first unknown name, or the first immutable / duplicate one (Redis reports an unknown name first). A duplicate is
   * the same name twice (in any case); a parameter and its alias are two names, the later value wins.
   */
  private static checkNames(ctx: CommandContext, pairs: ConfigSetInput['pairs']): [string, string] | null {
    const cfg = ctx.server.config;
    let unknown: string | null = null;
    let failure: [string, string] | null = null;
    const seen = new Set<string>();
    for (const [name] of pairs) {
      const canonical = ServerConfig.canonical(name);
      if (!cfg.has(canonical)) {
        unknown ??= name;
        continue;
      }
      if (unknown !== null || failure) continue;
      if (cfg.isImmutable(canonical)) failure = [name, ServerMessages.CONFIG_IMMUTABLE];
      else if (cfg.isProtected(canonical) && !ServerConfigService.protectedAllowed(ctx)) failure = [name, ServerMessages.CONFIG_PROTECTED];
      else if (seen.has(name.toLowerCase())) failure = [name, ServerMessages.CONFIG_DUPLICATE];
      seen.add(name.toLowerCase());
    }
    if (unknown !== null) throw new AppError(formatMessage(ServerMessages.CONFIG_SET_UNKNOWN, { name: unknown }));
    return failure;
  }

  /** enable-protected-configs: `yes`, or `local` for a loopback / unix socket client. */
  private static protectedAllowed(ctx: CommandContext): boolean {
    const mode = ctx.server.config.get('enable-protected-configs');
    return mode === 'yes' || (mode === 'local' && ctx.client.isLocal());
  }

  /** Validated values (the `dir` value resolved to an absolute path), or the first failure. */
  private static validate(cfg: ServerConfig, pairs: ConfigSetInput['pairs']): Array<[string, string]> {
    const values: Array<[string, string]> = [];
    for (const [name, value] of pairs) {
      const r = cfg.validate(name, value);
      if ('error' in r) throw ServerConfigService.setFailed(name, r.error);
      values.push([name, r.value]);
    }
    for (const entry of values) {
      if (ServerConfig.canonical(entry[0]) !== 'dir') continue;
      const dir = ServerFiles.resolveDir(entry[1]);
      if ('error' in dir) throw ServerConfigService.setFailed(entry[0], dir.error);
      entry[1] = dir.path;
    }
    return values;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /**
   * CONFIG GET pattern […]: an exact name (or alias) answers under the name exactly as typed, a glob pattern under every
   * matching parameter name and alias. A name already answered, in any case, is not repeated.
   */
  static get(ctx: CommandContext, { patterns }: ConfigGetInput): Reply {
    const cfg = ctx.server.config;
    const matched = new Map<string, [string, string]>();
    const add = (name: string, canonical: string) => {
      const key = name.toLowerCase();
      if (!matched.has(key)) matched.set(key, [name, cfg.get(canonical) ?? '']);
    };
    for (const pattern of patterns) {
      if (!/[*?[]/.test(pattern)) {
        const canonical = ServerConfig.canonical(pattern);
        if (cfg.has(canonical)) add(pattern, canonical);
        continue;
      }
      const glob = pattern.toLowerCase();
      for (const name of ServerConfig.allNames()) {
        if (cfg.has(name) && matchGlob(glob, name)) add(name, ServerConfig.canonical(name));
      }
    }
    return new RespMap([...matched.values()]);
  }

  /** CONFIG SET name value […]: every value is checked before any is applied; a failing side effect rolls back. */
  static set(ctx: CommandContext, { pairs }: ConfigSetInput): Reply {
    const cfg = ctx.server.config;
    const failure = ServerConfigService.checkNames(ctx, pairs);
    if (failure) throw ServerConfigService.setFailed(failure[0], failure[1]);
    const values = ServerConfigService.validate(cfg, pairs);
    const previous = values.map(([name]) => [name, cfg.get(name) ?? ''] as const);
    const apply = (list: ReadonlyArray<readonly [string, string]>) => {
      for (const [name, value] of list) {
        cfg.set(name, value);
        ctx.server.applyConfig(name, value);
      }
    };
    apply(values);
    // settings with side effects outside the config table (appendonly starts / stops the AOF)
    for (const [name] of values) {
      const reason = ctx.server.persistence.onConfigChange(ServerConfig.canonical(name));
      if (reason !== null) {
        apply(previous);
        throw ServerConfigService.setFailed(name, reason);
      }
    }
    return OK;
  }

  static resetStat(ctx: CommandContext): Reply {
    ctx.server.resetStats();
    return OK;
  }

  /** CONFIG REWRITE: redis-lite never runs from a config file it could rewrite. */
  static rewrite(): Reply {
    throw new AppError(ServerMessages.NO_CONFIG_FILE);
  }

  static help(): Reply {
    return CommandService.helpReply('config');
  }
}
