import { withDTO } from '@/modules/command/command.service';
import type { CommandSpec } from '@/modules/command/command.types';

import { FcallDTO, FunctionDTO } from './scripting.dto';
import ScriptingService from './scripting.service';

/** Routing of FUNCTION and FCALL / FCALL_RO: name, arity, flags, then DTO → service. No logic. */

const NOSCRIPT = { noscript: true } as const;

export const functionCommands: CommandSpec[] = [
  { name: 'function', arity: -2, flags: NOSCRIPT, handler: withDTO(FunctionDTO, ScriptingService.function) },
  { name: 'fcall', arity: -3, flags: NOSCRIPT, handler: withDTO(FcallDTO, (ctx, input) => ScriptingService.fcall(ctx, input)) },
  { name: 'fcall_ro', arity: -3, flags: NOSCRIPT, handler: withDTO(FcallDTO, (ctx, input) => ScriptingService.fcall(ctx, input, true)) },
];
