/**
 * Lua prelude, part 3 of 8: Redis Functions: redis.register_function (positional and named arguments) and the `__rl_*` helpers the engine calls during FUNCTION LOAD and FCALL.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_FUNCTIONS = String.raw`-- ---------- Redis Functions (FUNCTION LOAD / FCALL) ----------
__rl_functions = {}
local __pending = nil
local __staged = nil
local __function_flags = { 'no-writes', 'allow-oom', 'allow-stale', 'no-cluster', 'allow-cross-slot-keys' }
local function __register_error(msg) error({ err = 'ERR ' .. msg }) end
redis.register_function = function(...)
  if __pending == nil then error('redis.register_function can only be called on FUNCTION LOAD command', 2) end
  local argc = select('#', ...)
  local a, b = ...
  local name, cb, desc, flags = nil, nil, nil, {}
  if argc == 1 then
    if type(a) ~= 'table' then __register_error('calling redis.register_function with a single argument is only applicable to Lua table (representing named arguments).') end
    for k, v in pairs(a) do
      if type(k) ~= 'string' then __register_error('named argument key given to redis.register_function is not a string') end
      local key = k:lower()
      if key == 'function_name' then
        if type(v) ~= 'string' then __register_error('function_name argument given to redis.register_function must be a string') end
        name = v
      elseif key == 'description' then
        if type(v) ~= 'string' then __register_error('description argument given to redis.register_function must be a string') end
        desc = v
      elseif key == 'callback' then
        if type(v) ~= 'function' then __register_error('callback argument given to redis.register_function must be a function') end
        cb = v
      elseif key == 'flags' then
        if type(v) ~= 'table' then __register_error('flags argument to redis.register_function must be a table representing function flags') end
        local set = {}
        for _, f in ipairs(v) do
          local known = false
          if type(f) == 'string' then
            for _, def in ipairs(__function_flags) do if def == f then known = true end end
          end
          if not known then __register_error('unknown flag given') end
          set[f] = true
        end
        flags = {}
        for _, def in ipairs(__function_flags) do if set[def] then flags[#flags + 1] = def end end
      else
        __register_error('unknown argument given to redis.register_function')
      end
    end
    if name == nil then __register_error('redis.register_function must get a function name argument') end
    if cb == nil then __register_error('redis.register_function must get a callback argument') end
  elseif argc == 2 then
    if type(a) ~= 'string' then __register_error('first argument to redis.register_function must be a string') end
    if type(b) ~= 'function' then __register_error('second argument to redis.register_function must be a function') end
    name, cb = a, b
  else
    __register_error('wrong number of arguments to redis.register_function')
  end
  if not name:match('^[%w_]+$') then __register_error('Function names can only contain letters, numbers, or underscores(_) and must be at least one character long') end
  if __pending[name] then __register_error('Function already exists in the library') end
  __pending[name] = { fn = cb, flags = flags, description = desc }
end
redis.FUNCTION_FLAGS = { 'no-writes', 'allow-oom', 'allow-stale', 'no-cluster', 'allow-cross-slot-keys' }
function __rl_begin_load() __pending = {} end
function __rl_abort_load() __pending = nil __staged = nil end
function __rl_finish_load()
  local names = {}
  for name in pairs(__pending) do names[#names + 1] = name end
  table.sort(names)
  __staged, __pending = __pending, nil
  return names
end
function __rl_commit()
  for name, f in pairs(__staged or {}) do __rl_functions[name] = f.fn end
  __staged = nil
end
-- {has_description (0/1), description, flag...} of a staged function, read by the engine after __rl_finish_load.
function __rl_staged_meta(name)
  local f = __staged[name]
  local out = { f.description and 1 or 0, f.description or '' }
  for _, flag in ipairs(f.flags) do out[#out + 1] = flag end
  return out
end
function __rl_unregister(name) __rl_functions[name] = nil end
function __rl_call(name, keys, args)
  local f = __rl_functions[name]
  if f == nil then return redis.error_reply('ERR Function not found') end
  return f(keys, args)
end
redis.REDIS_VERSION_NUM = 0x080804

`;
