import { ACL_CATEGORIES } from './command.enums';
import CommandKeysService from './command.keys.service';
import CommandLookupService from './command.lookup.service';
import CommandReplyService from './command.reply.service';

/**
 * @deprecated Step-2 compatibility shim: the metadata API moved to `CommandService` (`command.service.ts`) and its types
 * to `command.types.ts`. Kept so modules that are not converted yet (scripting) still compile.
 */

export type { ArgDoc, BeginSearch, CommandMeta, FindKeys, KeyRef, KeySpec } from './command.types';

export { ACL_CATEGORIES };

export const parseArgs = CommandLookupService.parseArgs.bind(CommandLookupService);
export const allCommandMeta = CommandLookupService.allCommandMeta.bind(CommandLookupService);
export const allCommandsDeep = CommandLookupService.allCommandsDeep.bind(CommandLookupService);
export const getCommandMeta = CommandLookupService.getCommandMeta.bind(CommandLookupService);
export const lookupCommand = CommandLookupService.lookupCommand.bind(CommandLookupService);
export const arityOk = CommandLookupService.arityOk.bind(CommandLookupService);
export const keysFromSpecs = CommandKeysService.keysFromSpecs.bind(CommandKeysService);
export const commandHasKeys = CommandKeysService.commandHasKeys.bind(CommandKeysService);
export const commandInfoReply = CommandReplyService.commandInfoReply.bind(CommandReplyService);
export const commandDocsReply = CommandReplyService.commandDocsReply.bind(CommandReplyService);
