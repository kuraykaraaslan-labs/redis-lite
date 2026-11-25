import CommandBlockingService from './command.blocking.service';

/**
 * @deprecated Step-2 compatibility shim for modules that still import the blocking helpers from here (lists, zsets,
 * streams). Use `CommandService.blockingCommand` / `CommandService.parseTimeoutSeconds` or `BlockTimeoutSchema`.
 */
export const parseTimeoutSeconds = CommandBlockingService.parseTimeoutSeconds.bind(CommandBlockingService);

/** @deprecated See {@link parseTimeoutSeconds}. */
export const blockingCommand = CommandBlockingService.blockingCommand.bind(CommandBlockingService);
