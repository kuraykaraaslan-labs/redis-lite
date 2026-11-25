import { readFileSync } from 'node:fs';

import { AppError } from '@/libs/app-error';
import { formatMessage } from '@/libs/message-format';

import type { AclDenial, AclLogContext, AclLogInput, AclUser, KeyAccess } from '@/modules/acl/acl.core';
import { COMMANDS } from '@/modules/command/command.registry';
import CommandService from '@/modules/command/command.service';
import type { CommandMeta } from '@/modules/command/command.types';
import ConnectionService from '@/modules/connection/connection.service';

import type { Client } from './server.client';
import type { RedisLiteServer } from './server.core';
import { ServerFiles } from './server.files';
import ServerMessages from './server.messages';

// ============================================================================
// ACL Key Access
// ============================================================================

/** Redis keyspec flags → ACL key permission (ACLSelectorCheckKey: access = read; insert / delete / update = write). */
function keyAccess(key: string, flags: readonly string[]): KeyAccess {
  return {
    key,
    read: flags.includes('access'),
    write: flags.includes('insert') || flags.includes('delete') || flags.includes('update'),
  };
}

/** Keys of a command with their ACL flags; SET and BITFIELD have variable flags resolved like setGetKeys / bitfieldGetKeys. */
export function aclKeysOf(meta: CommandMeta, argv: string[]): KeyAccess[] {
  const name = meta.fullname;
  if (name === 'set' && argv.length >= 2) {
    const get = argv.slice(3).some((a) => a.toLowerCase() === 'get');
    return [keyAccess(argv[1], get ? ['RW', 'access', 'update'] : ['OW', 'update'])];
  }
  if (name === 'bitfield' && argv.length >= 2) {
    let readonly = true;
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i].toLowerCase();
      const rem = argv.length - i - 1;
      if (arg === 'get' && rem >= 2) i += 2;
      else if (arg === 'overflow' && rem >= 1) i += 1;
      else {
        readonly = false;
        break;
      }
    }
    return [keyAccess(argv[1], readonly ? ['RO', 'access'] : ['RW', 'access', 'update'])];
  }
  const refs = CommandService.keysFromSpecs(meta, argv) ?? [];
  return refs.map((r) => keyAccess(argv[r.index], r.flags));
}

// ============================================================================
// Access
// ============================================================================

/** The server side of ACLs: permission checks per command, ACL LOG entries, the ACL file, closing revoked clients. */
export class ServerAccess {
  constructor(private readonly server: RedisLiteServer) {}

  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** Closes a connection after the current reply when it is the caller, right away otherwise (freeClientAsync). */
  private killOrCloseAfterReply(target: Client, current: Client | null): void {
    if (target === current) target.closeAfterReply = true;
    else this.server.killClient(target);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** authRequired(): the default user needs a password (or is off) and this client has not authenticated. */
  authRequired(client: Client): boolean {
    return !client.authenticated && !this.server.acl.defaultLoginAllowed();
  }

  /** ACLCheckAllPerm() for argv (argv[0] included); null when allowed, the client is a superuser or the command is unknown. */
  aclDenial(client: Client, argv: string[], meta = CommandService.lookupCommand(argv).meta): AclDenial | null {
    const user = client.user;
    if (!user || !meta) return null;
    return this.aclCheckUser(user, argv, meta);
  }

  aclCheckUser(user: AclUser, argv: string[], meta: CommandMeta): AclDenial | null {
    const root = user.root;
    if (root.allCommands && root.allKeys && root.allChannels) return null;
    const command = meta.parent ? meta.parent.name : meta.name;
    const sub = meta.parent ? meta.name : null;
    const keys = user.selectors.some((s) => !s.allKeys) ? aclKeysOf(meta, argv) : [];
    const noauth = meta.flagSet.has('no_auth') || Boolean(COMMANDS.get(command)?.flags?.noauth);
    return this.server.acl.check(user, command, sub, argv.slice(1), keys, { noauth });
  }

  /** ACL LOG context of a client: `multi` while queueing or running a transaction. */
  aclContext(client: Client): AclLogContext {
    return client.multi || client.inExec ? 'multi' : 'toplevel';
  }

  /** addACLLogEntry(): ACL LOG + INFO acl_access_denied_* counters. */
  aclLog(client: Client, entry: Omit<AclLogInput, 'clientInfo'>): void {
    this.server.aclStats[entry.reason]++;
    this.server.acl.log({ ...entry, clientInfo: ConnectionService.clientInfoLine(this.server, client) });
  }

  aclLogDenial(client: Client, denial: AclDenial, context: AclLogContext): void {
    this.aclLog(client, { reason: denial.reason, context, object: denial.object, username: client.user?.name ?? 'default' });
  }

  /** ACLFreeUserAndKillClients(): every connection authenticated as `user` is closed (ACL DELUSER, ACL LOAD). */
  killUserClients(user: AclUser, current: Client | null): void {
    for (const c of [...this.server.clients]) {
      if (c.user !== user) continue;
      c.user = this.server.defaultUser;
      c.authenticated = false;
      this.killOrCloseAfterReply(c, current);
    }
  }

  /** ACLKillPubsubClientsIfNeeded(): subscribers of `user` holding a channel or pattern it may no longer access are closed. */
  killRevokedSubscribers(user: AclUser, current: Client | null): void {
    const acl = this.server.acl;
    for (const c of [...this.server.clients]) {
      if (c.user !== user || c.subscriptionCount === 0) continue;
      const revoked =
        [...c.channels].some((ch) => !acl.channelAllowed(user, ch, false)) ||
        [...c.shardChannels].some((ch) => !acl.channelAllowed(user, ch, false)) ||
        [...c.patterns].some((p) => !acl.channelAllowed(user, p, true));
      if (revoked) this.killOrCloseAfterReply(c, current);
    }
  }

  /** Reads the ACL file; throws AppError with Redis's ACL LOAD error text. Returns the names whose users changed. */
  loadAclFile(path: string, current: Client | null = null): string[] {
    const acl = this.server.acl;
    let text: string;
    try {
      text = readFileSync(path, 'latin1');
    } catch (e) {
      throw new AppError(formatMessage(ServerMessages.ACL_LOAD_OPEN, { path, error: ServerFiles.strerror(e) }));
    }
    const before = new Map(acl.users().map((n) => [n, acl.user(n)] as const));
    const changed = acl.loadFile(text, path);
    for (const name of changed) {
      const old = before.get(name);
      // the default user is updated in place and keeps its clients (pub/sub permissions are re-checked below)
      if (old && name !== 'default') this.killUserClients(old, current);
    }
    for (const u of before.values()) if (u && acl.user(u.name) === u) this.killRevokedSubscribers(u, current);
    return changed;
  }
}
