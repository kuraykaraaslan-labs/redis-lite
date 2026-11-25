import { formatMessage } from '@/libs/message-format';
import { RespMap, RespSet, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandMessages from './command.messages';
import { HELP_TEXT } from './command.meta_table';
import type { ArgDoc, CommandMeta, KeySpec } from './command.types';

/** Replies built from command metadata: COMMAND INFO and COMMAND DOCS entries, `<CMD> HELP` texts. */
export default class CommandReplyService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static statuses(items: string[]): RespSet {
    return new RespSet(items.map((s) => new Status(s)));
  }

  private static keySpecReply(spec: KeySpec): Reply {
    let begin: RespMap;
    if (spec.begin.type === 'index') begin = RespMap.from(['type', 'index', 'spec', RespMap.from(['index', spec.begin.index])]);
    else if (spec.begin.type === 'keyword')
      begin = RespMap.from(['type', 'keyword', 'spec', RespMap.from(['keyword', spec.begin.keyword, 'startfrom', spec.begin.startfrom])]);
    else begin = RespMap.from(['type', 'unknown', 'spec', new RespMap([])]);
    let find: RespMap;
    if (spec.find.type === 'range')
      find = RespMap.from(['type', 'range', 'spec', RespMap.from(['lastkey', spec.find.lastkey, 'keystep', spec.find.keystep, 'limit', spec.find.limit])]);
    else if (spec.find.type === 'keynum')
      find = RespMap.from([
        'type', 'keynum', 'spec', RespMap.from(['keynumidx', spec.find.keynumidx, 'firstkey', spec.find.firstkey, 'keystep', spec.find.keystep]),
      ]);
    else find = RespMap.from(['type', 'unknown', 'spec', new RespMap([])]);
    return RespMap.from(['flags', CommandReplyService.statuses(spec.flags), 'begin_search', begin, 'find_keys', find]);
  }

  private static argReply(a: ArgDoc): RespMap {
    const flat: Reply[] = ['name', a.name, 'type', a.type];
    if (a.display !== undefined) flat.push('display_text', a.display);
    if (a.keySpecIndex !== undefined) flat.push('key_spec_index', a.keySpecIndex);
    if (a.token !== undefined) flat.push('token', a.token);
    if (a.since !== undefined) flat.push('since', a.since);
    const flags: string[] = [];
    if (a.optional) flags.push('optional');
    if (a.multiple) flags.push('multiple');
    if (a.multipleToken) flags.push('multiple_token');
    if (flags.length) flat.push('flags', CommandReplyService.statuses(flags));
    if (a.args) flat.push('arguments', a.args.map((arg) => CommandReplyService.argReply(arg)));
    return RespMap.from(flat);
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** One COMMAND INFO entry. */
  static commandInfoReply(m: CommandMeta): Reply {
    return [
      m.fullname,
      m.arity,
      CommandReplyService.statuses(m.flags),
      m.firstKey,
      m.lastKey,
      m.step,
      CommandReplyService.statuses(m.acl.map((c) => `@${c}`)),
      CommandReplyService.statuses(m.tips),
      m.keySpecs.map((spec) => CommandReplyService.keySpecReply(spec)),
      [...m.subcommands.values()].map((sub) => CommandReplyService.commandInfoReply(sub)),
    ];
  }

  /** One COMMAND DOCS entry (the value; the caller pairs it with the name). */
  static commandDocsReply(m: CommandMeta): RespMap {
    const flat: Reply[] = ['summary', m.summary, 'since', m.since, 'group', m.group];
    if (m.complexity) flat.push('complexity', m.complexity);
    if (m.module) flat.push('module', m.module);
    if (m.docFlags.length) flat.push('doc_flags', CommandReplyService.statuses(m.docFlags));
    if (m.deprecatedSince) flat.push('deprecated_since', m.deprecatedSince);
    if (m.replacedBy) flat.push('replaced_by', m.replacedBy);
    if (m.args.length) flat.push('arguments', m.args.map((arg) => CommandReplyService.argReply(arg)));
    if (m.subcommands.size) {
      flat.push('subcommands', new RespMap([...m.subcommands.values()].map((s) => [s.fullname, CommandReplyService.commandDocsReply(s)])));
    }
    return RespMap.from(flat);
  }

  /** `<CMD> HELP` reply (Redis addReplyHelp()): status lines, HELP appended. `lines` defaults to the command's help table. */
  static helpReply(command: string, lines: readonly string[] = HELP_TEXT[command] ?? []): Reply {
    const header = formatMessage(CommandMessages.HELP_HEADER, { command: command.toUpperCase() });
    return [header, ...lines, CommandMessages.HELP_FOOTER_NAME, CommandMessages.HELP_FOOTER_TEXT].map((l) => new Status(l));
  }

  /** Redis addReplySubcommandSyntaxError() text: the subcommand as typed (at most 128 bytes) and the container in capitals. */
  static subcommandSyntaxMessage(sub: string, command: string): string {
    return formatMessage(CommandMessages.SUBCOMMAND_SYNTAX, { subcommand: sub.slice(0, 128), command: command.toUpperCase() });
  }
}
