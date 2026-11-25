import CommandBlockingService from './command.blocking.service';
import CommandKeysService from './command.keys.service';
import CommandLookupService from './command.lookup.service';
import CommandReplyService from './command.reply.service';

export { CommandBlockingService, CommandKeysService, CommandLookupService, CommandReplyService };

/** The command module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class CommandService {
  // Lookup — the metadata table, (sub)command lookup, arity
  static parseArgs = CommandLookupService.parseArgs.bind(CommandLookupService);
  static allCommandMeta = CommandLookupService.allCommandMeta.bind(CommandLookupService);
  static allCommandsDeep = CommandLookupService.allCommandsDeep.bind(CommandLookupService);
  static getCommandMeta = CommandLookupService.getCommandMeta.bind(CommandLookupService);
  static lookupCommand = CommandLookupService.lookupCommand.bind(CommandLookupService);
  static arityOk = CommandLookupService.arityOk.bind(CommandLookupService);

  // Keys — key specs applied to a command line
  static keysFromSpecs = CommandKeysService.keysFromSpecs.bind(CommandKeysService);
  static keyNames = CommandKeysService.keyNames.bind(CommandKeysService);
  static commandHasKeys = CommandKeysService.commandHasKeys.bind(CommandKeysService);

  // Replies — COMMAND INFO / DOCS entries, HELP, subcommand errors
  static commandInfoReply = CommandReplyService.commandInfoReply.bind(CommandReplyService);
  static commandDocsReply = CommandReplyService.commandDocsReply.bind(CommandReplyService);
  static helpReply = CommandReplyService.helpReply.bind(CommandReplyService);
  static subcommandSyntaxMessage = CommandReplyService.subcommandSyntaxMessage.bind(CommandReplyService);

  // Blocking — the shared shape of blocking commands
  static parseTimeoutSeconds = CommandBlockingService.parseTimeoutSeconds.bind(CommandBlockingService);
  static blockingCommand = CommandBlockingService.blockingCommand.bind(CommandBlockingService);
}
