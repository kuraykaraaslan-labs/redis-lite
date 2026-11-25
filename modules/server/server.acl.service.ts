import { renameSync, writeFileSync } from 'node:fs';

import { AppError } from '@/libs/app-error';
import Logger from '@/libs/logger';
import { formatMessage } from '@/libs/message-format';
import { OK } from '@/libs/resp';
import type { Reply } from '@/libs/resp';
import { wrongArity } from '@/libs/resp/messages';

import AclMessages from '@/modules/acl/acl.messages';
import AclService from '@/modules/acl/acl.service';
import CommandService from '@/modules/command/command.service';
import type { CommandContext } from '@/modules/command/command.types';

import type {
  AclCatInput,
  AclDelUserInput,
  AclDryRunInput,
  AclGenPassInput,
  AclGetUserInput,
  AclLogInput,
  AclSetUserInput,
} from './server.dto';
import ServerMessages from './server.messages';

/** ACL (aclCommand in acl.c): users, the ACL file, categories, ACL LOG, DRYRUN, GENPASS. */
export default class ServerAclService {
  // ──────────────────────────────────────────────
  // Public Methods: users
  // ──────────────────────────────────────────────

  /** ACL SETUSER: subscribers that lost access to a channel are closed. */
  static setUser(ctx: CommandContext, { username, rules }: AclSetUserInput): Reply {
    const engine = ctx.server.acl;
    engine.setUser(username, rules);
    const u = engine.user(username);
    if (u) ctx.server.killRevokedSubscribers(u, ctx.client);
    return OK;
  }

  /** ACL DELUSER: the connections of deleted users are closed; `default` can never be deleted. */
  static delUser(ctx: CommandContext, { usernames }: AclDelUserInput): Reply {
    const engine = ctx.server.acl;
    if (usernames.includes('default')) throw new AppError(AclMessages.DEFAULT_UNDELETABLE);
    const users = [...new Set(usernames)].map((n) => engine.user(n)).filter((u) => u !== undefined);
    const deleted = engine.deleteUser(usernames);
    for (const u of users) ctx.server.killUserClients(u, ctx.client);
    return deleted;
  }

  static getUser(ctx: CommandContext, { username }: AclGetUserInput): Reply {
    return ctx.server.acl.getUserReply(username);
  }

  static list(ctx: CommandContext): Reply {
    return ctx.server.acl.list();
  }

  static users(ctx: CommandContext): Reply {
    return ctx.server.acl.users();
  }

  static whoAmI(ctx: CommandContext): Reply {
    return ctx.client.user ? ctx.client.user.name : null;
  }

  // ──────────────────────────────────────────────
  // Public Methods: the ACL file
  // ──────────────────────────────────────────────

  /** The configured ACL file, read before ACL LOAD / SAVE look at their arguments (as in Redis). */
  static aclFile(ctx: CommandContext): string {
    const aclfile = ctx.server.config.get('aclfile') ?? '';
    if (!aclfile) throw new AppError(ServerMessages.NO_ACL_FILE);
    return aclfile;
  }

  static load(ctx: CommandContext, aclfile: string): Reply {
    ctx.server.loadAclFile(aclfile, ctx.client);
    return OK;
  }

  /** ACL SAVE: write a temp file and rename it over the ACL file (ACLSaveToFile). */
  static save(ctx: CommandContext, aclfile: string): Reply {
    const tmp = `${aclfile}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, Buffer.from(ctx.server.acl.toFile(), 'latin1'));
      renameSync(tmp, aclfile);
    } catch (e) {
      Logger.warn('[ServerAclService.save] Saving the ACL file failed', { error: (e as Error).message });
      throw new AppError(ServerMessages.ACL_SAVE_FAILED);
    }
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods: inspection
  // ──────────────────────────────────────────────

  /** ACL CAT [category]: the categories, or the commands of one. */
  static cat(ctx: CommandContext, { category }: AclCatInput): Reply {
    return category === null ? ctx.server.acl.categories() : ctx.server.acl.commandsInCategory(category);
  }

  static log(ctx: CommandContext, { reset, count }: AclLogInput): Reply {
    if (!reset) return ctx.server.acl.logReply(count);
    ctx.server.acl.resetLog();
    return OK;
  }

  /** ACL DRYRUN user command [arg …]: OK, or why the user may not run it. */
  static dryRun(ctx: CommandContext, { username, argv }: AclDryRunInput): Reply {
    const user = ctx.server.acl.user(username);
    if (!user) throw new AppError(formatMessage(AclMessages.USER_NOT_FOUND, { name: username }));
    const { meta } = CommandService.lookupCommand(argv);
    if (!meta) throw new AppError(formatMessage(AclMessages.COMMAND_NOT_FOUND, { name: argv[0] }));
    if (!CommandService.arityOk(meta.arity, argv.length)) throw new AppError(wrongArity(meta.fullname));
    const denial = ctx.server.aclCheckUser(user, argv, meta);
    return denial ? AclService.denialMessage(denial, user.name, true) : OK;
  }

  static genPass(_ctx: CommandContext, { bits }: AclGenPassInput): Reply {
    return AclService.genPass(bits);
  }

  static help(): Reply {
    return CommandService.helpReply('acl');
  }
}
