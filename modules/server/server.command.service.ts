import { AppError } from '@/libs/app-error';
import { matchGlob } from '@/libs/glob';
import { RespMap, RespSet, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandMeta } from '@/modules/command/command.types';

import type { CommandGetKeysInput, CommandListInput, CommandNamesInput } from './server.dto';
import ServerMessages from './server.messages';

/** COMMAND: the command table (INFO, DOCS, COUNT, LIST) and key extraction (GETKEYS, GETKEYSANDFLAGS). */
export default class ServerCommandService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** The named commands (unknown names as undefined), or every command when no name is given. */
  private static metas(names: string[]): Array<CommandMeta | undefined> {
    return names.length ? names.map((n) => CommandService.getCommandMeta(n)) : CommandService.allCommandMeta();
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** COMMAND with no subcommand: COMMAND INFO of every command. */
  static all(): Reply {
    return CommandService.allCommandMeta().map((m) => CommandService.commandInfoReply(m));
  }

  static count(): Reply {
    return CommandService.allCommandMeta().length;
  }

  /** COMMAND LIST [FILTERBY …]: full names, subcommands included. */
  static list(_ctx: unknown, { filter }: CommandListInput): Reply {
    const all = CommandService.allCommandsDeep();
    if (!filter) return all.map((m) => m.fullname);
    const value = filter.value;
    let keep: (m: CommandMeta) => boolean;
    if (filter.kind === 'module') keep = () => false;
    else if (filter.kind === 'aclcat') keep = (m) => m.acl.includes(value.toLowerCase());
    else keep = (m) => matchGlob(value.toLowerCase(), m.fullname);
    return all.filter(keep).map((m) => m.fullname);
  }

  /** COMMAND INFO [name …]: null for unknown names. */
  static info(_ctx: unknown, { names }: CommandNamesInput): Reply {
    return ServerCommandService.metas(names).map((m) => (m ? CommandService.commandInfoReply(m) : null));
  }

  /** COMMAND DOCS [name …]: unknown names are left out. */
  static docs(_ctx: unknown, { names }: CommandNamesInput): Reply {
    const metas = ServerCommandService.metas(names).filter((m): m is CommandMeta => Boolean(m));
    return new RespMap(metas.map((m) => [m.fullname, CommandService.commandDocsReply(m)]));
  }

  /** COMMAND GETKEYS / GETKEYSANDFLAGS: the keys of a full command line, with their key spec flags when asked. */
  static getKeys({ argv }: CommandGetKeysInput, withFlags: boolean): Reply {
    const { meta } = CommandService.lookupCommand(argv);
    if (!meta) throw new AppError(ServerMessages.COMMAND_INVALID);
    if (!CommandService.commandHasKeys(meta)) throw new AppError(ServerMessages.COMMAND_NO_KEYS);
    if (!CommandService.arityOk(meta.arity, argv.length)) throw new AppError(ServerMessages.COMMAND_INVALID_ARGC);
    const keys = CommandService.keysFromSpecs(meta, argv);
    if (!keys?.length) {
      if (meta.flagSet.has('no_mandatory_keys')) return [];
      throw new AppError(ServerMessages.COMMAND_INVALID_ARGS);
    }
    if (!withFlags) return keys.map((k) => argv[k.index]);
    return keys.map((k) => [argv[k.index], new RespSet(k.flags.map((f) => new Status(f)))]);
  }

  static help(): Reply {
    return CommandService.helpReply('command');
  }
}
