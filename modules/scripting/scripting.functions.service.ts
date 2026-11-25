import { AppError } from '@/libs/app-error';
import { matchGlob } from '@/libs/glob';
import { OK, RespMap, RespSet } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';
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

  /** One FUNCTION LIST entry. */
  private static describe(lib: LuaLibrary, withCode: boolean): RespMap {
    const entry: Reply[] = [
      'library_name',
      lib.name,
      'engine',
      'LUA',
      'functions',
      lib.functions.map((f) => {
        const meta = lib.meta.get(f);
        return RespMap.from(['name', f, 'description', meta?.description ?? null, 'flags', new RespSet(meta?.flags ?? [])]);
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

  private static stats(lua: LuaEngine): Reply {
    const libs = [...lua.libraries.values()];
    const functionsCount = libs.reduce((n, l) => n + l.functions.length, 0);
    const engine = RespMap.from(['libraries_count', libs.length, 'functions_count', functionsCount]);
    return RespMap.from(['running_script', null, 'engines', RespMap.from(['LUA', engine])]);
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
    for (const code of codes) lua.loadLibrary(code, policy === 'replace');
    return OK;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** FCALL / FCALL_RO (`readOnly`). */
  static fcall(ctx: CommandContext, { name, keys, argv }: FcallInput, readOnly = false): Reply {
    return ctx.server.lua.callFunction(ctx.client, name, keys, argv, readOnly);
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
        throw new AppError(ScriptingMessages.NOTBUSY);
      case 'help':
        return [ScriptingMessages.FUNCTION_HELP];
    }
  }
}
