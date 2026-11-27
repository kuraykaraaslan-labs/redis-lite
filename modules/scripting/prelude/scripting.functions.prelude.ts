/**
 * Lua prelude, part 3 of 8: Redis Functions. A library body runs with its own `_ENV` (`fn_env`): while FUNCTION LOAD
 * runs it, that environment holds only a reduced `redis` table (register_function, log, the LOG_* levels and the
 * version); afterwards it falls through to the functions' globals (the scripts' ones without KEYS, ARGV and the EVAL
 * error handler), so the registered functions see the full runtime
 * (where `redis.register_function` does not exist). Functions are found case-insensitively by FCALL.
 *
 * The engine drives a load with the `RL.*_load` helpers (the `RL` table lives in the registry, out of the scripts'
 * reach): begin_load → run the body → finish_load (names in registration order) → staged_meta → commit.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_FUNCTIONS = String.raw`-- ---------- Redis Functions (FUNCTION LOAD / FCALL) ----------
local function missing_global(_, name)
  __error("Script attempted to access nonexistent global variable '" .. __tostring(name) .. "'", 2)
end
local function readonly_error() __error('Attempt to modify a readonly table', 2) end

-- Registered functions by lowercased name.
local __functions = {}
local __pending = nil
local __staged = nil
local FUNCTION_FLAGS = { 'no-writes', 'allow-oom', 'allow-stale', 'no-cluster', 'allow-cross-slot-keys' }
local function register_error(msg) __error({ err = 'ERR ' .. msg }) end

local function register_function(...)
  if __pending == nil then __error('redis.register_function can only be called on FUNCTION LOAD command', 2) end
  local argc = __select('#', ...)
  local a, b = ...
  local name, cb, desc, flags = nil, nil, nil, {}
  if argc == 1 then
    if __type(a) ~= 'table' then register_error('calling redis.register_function with a single argument is only applicable to Lua table (representing named arguments).') end
    for k, v in __pairs(a) do
      if __type(k) ~= 'string' then register_error('named argument key given to redis.register_function is not a string') end
      local key = slower(k)
      if key == 'function_name' then
        if __type(v) ~= 'string' then register_error('function_name argument given to redis.register_function must be a string') end
        name = v
      elseif key == 'description' then
        if __type(v) ~= 'string' then register_error('description argument given to redis.register_function must be a string') end
        desc = v
      elseif key == 'callback' then
        if __type(v) ~= 'function' then register_error('callback argument given to redis.register_function must be a function') end
        cb = v
      elseif key == 'flags' then
        if __type(v) ~= 'table' then register_error('flags argument to redis.register_function must be a table representing function flags') end
        local set = {}
        for _, f in __ipairs(v) do
          local known = false
          if __type(f) == 'string' then
            for _, def in __ipairs(FUNCTION_FLAGS) do if def == f then known = true end end
          end
          if not known then register_error('unknown flag given') end
          set[f] = true
        end
        flags = {}
        for _, def in __ipairs(FUNCTION_FLAGS) do if set[def] then flags[#flags + 1] = def end end
      else
        register_error('unknown argument given to redis.register_function')
      end
    end
    if name == nil then register_error('redis.register_function must get a function name argument') end
    if cb == nil then register_error('redis.register_function must get a callback argument') end
  elseif argc == 2 then
    if __type(a) ~= 'string' then register_error('first argument to redis.register_function must be a string') end
    if __type(b) ~= 'function' then register_error('second argument to redis.register_function must be a function') end
    name, cb = a, b
  else
    register_error('wrong number of arguments to redis.register_function')
  end
  if not smatch(name, '^[%w_]+$') then -- Redis 7.0 words a bad function name like a bad library name
    register_error('Library names can only contain letters, numbers, or underscores(_) and must be at least one character long') end
  if __pending.byname[name] then register_error('Function already exists in the library') end
  __pending.byname[name] = { fn = cb, flags = flags, description = desc }
  __pending.names[#__pending.names + 1] = name
end

-- What a library body sees while it loads; anything else is a "nonexistent global variable".
local load_redis = __setmetatable({
  register_function = register_function,
  log = redis.log,
  LOG_DEBUG = redis.LOG_DEBUG, LOG_VERBOSE = redis.LOG_VERBOSE, LOG_NOTICE = redis.LOG_NOTICE, LOG_WARNING = redis.LOG_WARNING,
  REDIS_VERSION = redis.REDIS_VERSION, REDIS_VERSION_NUM = redis.REDIS_VERSION_NUM,
}, { __index = missing_global, __newindex = readonly_error, __metatable = false })
local load_env = __setmetatable({ redis = load_redis }, { __index = missing_global, __newindex = readonly_error, __metatable = false })
-- The _ENV of every library; its __index is switched to the scripts' globals by the sandbox and after each load.
-- The __index of a library's _ENV once loaded (set by the sandbox).
local fn_globals = nil
local fn_env_mt = { __index = load_env, __newindex = readonly_error, __metatable = false }
local fn_env = __setmetatable({}, fn_env_mt)

-- Helpers the engine calls (kept in the registry by the sandbox, out of the scripts' reach).
local RL = {}
RL.begin_load = function(chunk)
  __debug.setupvalue(chunk, 1, fn_env)
  __pending = { names = {}, byname = {} }
  fn_env_mt.__index = load_env
end
RL.abort_load = function()
  __pending, __staged = nil, nil
  fn_env_mt.__index = fn_globals
end
RL.finish_load = function()
  __staged, __pending = __pending, nil
  fn_env_mt.__index = fn_globals
  return __staged.names
end
-- {has_description (0/1), description, flag...} of a staged function.
RL.staged_meta = function(name)
  local f = __staged.byname[name]
  local out = { f.description and 1 or 0, f.description or '' }
  for _, flag in __ipairs(f.flags) do out[#out + 1] = flag end
  return out
end
RL.commit = function()
  for _, name in __ipairs(__staged.names) do __functions[slower(name)] = __staged.byname[name].fn end
  __staged = nil
end
RL.unregister = function(name) __functions[slower(name)] = nil end

`;
