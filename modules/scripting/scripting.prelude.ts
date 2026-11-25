import { LUA_BIT } from './prelude/scripting.bit.prelude';
import { LUA_CJSON } from './prelude/scripting.cjson.prelude';
import { LUA_CMSGPACK } from './prelude/scripting.cmsgpack.prelude';
import { LUA_COMPAT } from './prelude/scripting.compat.prelude';
import { LUA_FUNCTIONS } from './prelude/scripting.functions.prelude';
import { LUA_REDIS } from './prelude/scripting.redis.prelude';
import { LUA_SANDBOX } from './prelude/scripting.sandbox.prelude';
import { LUA_STRUCT } from './prelude/scripting.struct.prelude';

/**
 * Lua prelude run once per Lua state. Makes Lua 5.4 look like the Lua 5.1 that Redis embeds, and provides the libraries
 * Redis scripts expect: `redis.*`, `cjson`, `cmsgpack`, `bit`, `struct`. Everything is plain Lua so it works on byte
 * strings.
 *
 * One file per library under `prelude/`, concatenated into a single chunk in this order: later parts use locals of
 * earlier ones (`sformat`, `num2str`, `normnum`, `is_array`), and the sandbox must come last because it freezes every
 * table defined before it.
 */
export const LUA_PRELUDE = [
  LUA_COMPAT,
  LUA_REDIS,
  LUA_FUNCTIONS,
  LUA_BIT,
  LUA_CJSON,
  LUA_CMSGPACK,
  LUA_STRUCT,
  LUA_SANDBOX,
].join('');
