import ScriptingFunctionsService from './scripting.functions.service';
import ScriptingScriptsService from './scripting.scripts.service';

export { ScriptingFunctionsService, ScriptingScriptsService };
/**
 * The Lua engine is exported as a type only: its module reaches the command registry (redis.call), so a value re-export
 * here would load the registry before ScriptingService exists. The server builds it from scripting.engine.ts.
 */
export type { LuaEngine } from './scripting.engine';

/** The scripting module's public API: one flat facade over the sub-services (other modules import only this class). */
export default class ScriptingService {
  // Scripts — EVAL, EVALSHA (+ _RO), SCRIPT
  static cacheScript = ScriptingScriptsService.cacheScript.bind(ScriptingScriptsService);
  static cachedScript = ScriptingScriptsService.cachedScript.bind(ScriptingScriptsService);
  static eval = ScriptingScriptsService.eval.bind(ScriptingScriptsService);
  static evalSha = ScriptingScriptsService.evalSha.bind(ScriptingScriptsService);
  static script = ScriptingScriptsService.script.bind(ScriptingScriptsService);

  // Functions — FCALL (+ _RO), FUNCTION
  static fcall = ScriptingFunctionsService.fcall.bind(ScriptingFunctionsService);
  static function = ScriptingFunctionsService.function.bind(ScriptingFunctionsService);
}
