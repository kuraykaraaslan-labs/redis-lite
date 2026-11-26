import { AppError } from '@/libs/app-error';
import { matchGlob } from '@/libs/glob';
import { OK, RespError, RespMap, RespSet, Status } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import CommandService from '@/modules/command/command.service';
import type { CommandContext, HandlerResult } from '@/modules/command/command.types';
import PersistenceService from '@/modules/persistence/persistence.service';

import type { FcallInput, FunctionInput } from './scripting.dto';
import type { LuaEngine } from './scripting.engine';
import ScriptingMessages from './scripting.messages';
import type { LuaLibrary } from './scripting.types';

type ListInput = Extract<FunctionInput, { subcommand: 'list' }>;
type RestoreInput = Extract<FunctionInput, { subcommand: 'restore' }>;

/** Redis Functions: FCALL / FCALL_RO and FUNCTION LOAD, DELETE, FLUSH, LIST, STATS, DUMP, RESTORE, KILL, HELP. */
export default class ScriptingFunctionsService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  private static deleteAll(lua: LuaEngine): void {
    for (const name of [...lua.libraries.keys()]) lua.deleteLibrary(name);
  }

  /** One FUNCTION LIST entry; flags are simple strings. */
  private static describe(lib: LuaLibrary, withCode: boolean): RespMap {
    const entry: Reply[] = [
      'library_name',
      lib.name,
      'engine',
      'LUA',
      'functions',
      lib.functions.map((f) => {
        const meta = lib.meta.get(f);
        const flags = (meta?.flags ?? []).map((flag) => new Status(flag));
        return RespMap.from(['name', f, 'description', meta?.description ?? null, 'flags', new RespSet(flags)]);
      }),
    ];
    if (withCode) entry.push('library_code', lib.code);
    return RespMap.from(entry);
  }

  private static list(lua: LuaEngine, { pattern, withCode }: ListInput): Reply {
    return [...lua.libraries.values()]
      .filter((lib) => matchGlob(pattern, lib.name))
      .map((lib) => ScriptingFunctionsService.describe(lib, withCode));
  }

  /** FUNCTION STATS: the running function (refused while an EVAL script runs) and the engine's counts. */
  private static stats(lua: LuaEngine): Reply {
    const running = lua.running;
    if (running?.kind === 'eval') return new RespError(ScriptingMessages.BUSY_SCRIPT);
    const runningScript = running
      ? RespMap.from(['name', running.name, 'command', running.command, 'duration_ms', Date.now() - running.startedAt])
      : null;
    const libs = [...lua.libraries.values()];
    const functionsCount = libs.reduce((n, l) => n + l.functions.length, 0);
    const engine = RespMap.from(['libraries_count', libs.length, 'functions_count', functionsCount]);
    return RespMap.from(['running_script', runningScript, 'engines', RespMap.from(['LUA', engine])]);
  }

  /** FUNCTION RESTORE: the payload is checked whole before any library changes. */
  private static restore(lua: LuaEngine, { payload, policy }: RestoreInput): Reply {
    let codes: string[];
    try {
      codes = PersistenceService.functionsRestorePayload(Buffer.from(payload, 'latin1'));
    } catch (error) {
      const msg = (error as Error).message;
      throw new AppError(
        msg.includes('version or checksum') ? ScriptingMessages.RESTORE_CHECKSUM : ScriptingMessages.RESTORE_INVALID_PAYLOAD,
      );
    }
    if (policy === 'flush') ScriptingFunctionsService.deleteAll(lua);
    for (const code of codes) lua.loadLibrary(code, policy === 'replace', true);
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** FCALL / FCALL_RO (`readOnly`). */
  static fcall(ctx: CommandContext, { name, keys, argv }: FcallInput, readOnly = false): HandlerResult {
    const command = [ctx.name ?? 'FCALL', name, String(keys.length), ...keys, ...argv];
    const call = { client: ctx.client, command, readOnly, topLevel: !ctx.noBlock && !ctx.inScript };
    return ctx.server.lua.callFunction(call, name, keys, argv);
  }

  /** FUNCTION <subcommand>. */
  static function(ctx: CommandContext, input: FunctionInput): Reply {
    const lua = ctx.server.lua;
    switch (input.subcommand) {
      case 'load':
        return lua.loadLibrary(input.code, input.replace);
      case 'delete':
        if (!lua.deleteLibrary(input.library)) throw new AppError(ScriptingMessages.LIBRARY_NOT_FOUND);
        return OK;
      case 'flush':
        ScriptingFunctionsService.deleteAll(lua);
        return OK;
      case 'list':
        return ScriptingFunctionsService.list(lua, input);
      case 'stats':
        return ScriptingFunctionsService.stats(lua);
      case 'dump':
        return PersistenceService.functionsDumpPayload([...lua.libraries.values()].map((l) => l.code)).toString('latin1');
      case 'restore':
        return ScriptingFunctionsService.restore(lua, input);
      case 'kill':
        return lua.kill('function') ?? OK;
      case 'help':
        return CommandService.helpReply('function', ScriptingMessages.FUNCTION_HELP);
    }
  }
}
