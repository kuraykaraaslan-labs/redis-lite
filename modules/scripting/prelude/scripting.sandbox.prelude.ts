/**
 * Lua prelude, part 8 of 8: the Lua 5.1 global set and global protection (Redis 7). Must run last: it replaces the
 * library tables with their 5.1 contents and wraps every table defined before it.
 *
 * - Globals and library tables hold exactly what Redis 7's Lua 5.1 has (no print, rawlen, utf8, table.unpack…;
 *   setfenv, getfenv, unpack, newproxy, gcinfo, math.atan2…), and `_VERSION` is 'Lua 5.1'. `os` keeps `os.clock`
 *   (Redis 8).
 * - Scripts see a proxy for _G and for every library table: reads fall through to the real table, writes raise
 *   "Attempt to modify a readonly table", reading a missing global raises; setmetatable and rawset refuse the
 *   protected tables. The string metatable's __index is the protected `string`.
 * - The engine's helpers (`RL`) are stored in the registry (`__rl`), out of the scripts' reach: the real globals (for
 *   KEYS / ARGV), the script threads, the error position of a failed thread, the FUNCTION LOAD protocol.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_SANDBOX = String.raw`-- ---------- Lua 5.1 globals and global protection ----------
local __real_G = _G
do
  local string51 = {
    byte = string.byte, char = string.char, dump = string.dump, find = string.find, format = format51,
    gfind = string.gmatch, gmatch = string.gmatch, gsub = string.gsub, len = string.len, lower = string.lower,
    match = string.match, rep = rep51, reverse = string.reverse, sub = string.sub, upper = string.upper,
  }
  table51.concat, table51.sort = concat51, table.sort
  for _, name in __ipairs({ 'abs', 'acos', 'asin', 'atan', 'cos', 'deg', 'exp', 'floor', 'huge', 'modf', 'pi', 'rad', 'sin',
    'sqrt', 'tan' }) do
    math51[name] = math[name]
  end
  string, table, math, coroutine = string51, table51, math51, co51
  os = { clock = os.clock }
  unpack, loadstring, load, tonumber = tunpack, loadstring51, load51, tonumber51
  getfenv, setfenv, gcinfo = getfenv51, setfenv51, gcinfo51
  newproxy = function(...) return __newproxy(...) end
  for _, name in __ipairs({ 'print', 'rawlen', 'utf8', 'warn', 'require', 'dofile', 'loadfile', 'io', 'package' }) do
    __real_G[name] = nil
  end
  _VERSION = 'Lua 5.1'
end
KEYS, ARGV = {}, {}

-- proxy -> the table it protects
local __protected = __setmetatable({}, { __mode = 'k' })
local function protect(t)
  local proxy = {}
  __protected[proxy] = t
  return __setmetatable(proxy, {
    __index = t,
    __newindex = readonly_error,
    __pairs = function() return __next, t, nil end,
    __len = function() return #t end,
    __metatable = false,
  })
end
for _, name in __ipairs({ 'redis', 'cjson', 'cmsgpack', 'bit', 'struct', 'string', 'math', 'table', 'os', 'coroutine' }) do
  __real_G[name] = protect(__real_G[name])
end
__getmetatable('').__index = __real_G.string
rawset = function(t, k, v)
  if __protected[t] then __error('Attempt to modify a readonly table', 2) end
  return __rawset(t, k, v)
end
setmetatable = function(t, mt)
  if __protected[t] then __error('Attempt to modify a readonly table', 0) end
  local r = B.setmetatable(t, mt)
  return r
end
local __proxy_G = __setmetatable({}, {
  __index = __real_G,
  __newindex = readonly_error,
  __pairs = function() return __next, __real_G, nil end,
  __metatable = false,
})
__protected[__proxy_G] = __real_G
__real_G._G = __proxy_G
-- rawget / next see the protected tables through their proxies (Redis protects real tables, without a metatable);
-- getmetatable shows none on a library table and a copy of the globals' one on _G.
local G_META = { __index = missing_global, __newindex = readonly_error }
B.rawget, B.next = __rawget, __next
rawget = function(t, k)
  local r = B.rawget(__protected[t] or t, k)
  return r
end
next = function(t, k)
  local a, b = B.next(__protected[t] or t, k)
  return a, b
end
getmetatable = function(t)
  if __protected[t] then
    if t ~= __proxy_G then return nil end
    return { __index = G_META.__index, __newindex = G_META.__newindex }
  end
  return __getmetatable(t)
end
__setmetatable(__real_G, { __index = missing_global, __newindex = readonly_error, __metatable = false })
__globals = __proxy_G
fn_env_mt.__index = __proxy_G

-- ---------- engine helpers ----------
-- The real globals table: the engine writes KEYS / ARGV into it directly (scripts see it read-only).
RL.globals = __real_G
-- A thread the engine runs scripts in (coroutine.running() is nil there).
RL.mark_thread = function(co) __script_threads[co] = true end
-- Function name (case-insensitive), or nil.
RL.function_value = function(name) return __functions[slower(name)] end
-- The line of the innermost frame of user code on a failed or suspended thread (0 when there is none).
RL.error_line = function(co)
  local level = 0
  while true do
    local info = __getinfo(co, level, 'Sl')
    if info == nil then return 0 end
    if info.currentline > 0 and info.source ~= '=prelude' then return info.currentline end
    level = level + 1
  end
end
-- Chunks loaded from now on (scripts, function libraries, loadstring) get the proxy as their _ENV.
__debug.getregistry()[2] = __proxy_G
__debug.getregistry().__rl = RL
debug = nil
`;
