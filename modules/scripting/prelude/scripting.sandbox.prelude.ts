/**
 * Lua prelude, part 8 of 8: Global protection (Redis 7): read-only globals and library tables, an error on reading a nonexistent global, `__rl_set_global` for KEYS / ARGV. Must run last: it wraps every table defined before it.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_SANDBOX = String.raw`-- ---------- global protection (Redis 7: readonly globals, error on nonexistent globals) ----------
-- Scripts see a proxy for _G and for every library table: reads fall through to the real table, writes raise
-- "Attempt to modify a readonly table", and reading a missing global raises. The engine sets KEYS/ARGV through
-- __rl_set_global, which writes the real table directly.
local __real_G = _G
KEYS, ARGV = {}, {}
local function readonly_error() error('Attempt to modify a readonly table', 2) end
local __protected = setmetatable({}, { __mode = 'k' })
local function protect(t)
  local proxy = {}
  __protected[proxy] = true
  return setmetatable(proxy, {
    __index = t,
    __newindex = readonly_error,
    __pairs = function() return next, t, nil end,
    __len = function() return #t end,
    __metatable = false,
  })
end
for _, name in ipairs({ 'redis', 'cjson', 'cmsgpack', 'bit', 'struct', 'string', 'math', 'table', 'os', 'coroutine', 'utf8' }) do
  __real_G[name] = protect(__real_G[name])
end
local __rawset_real = rawset
function __rl_set_global(name, value) __rawset_real(__real_G, name, value) end
local __proxy_G = setmetatable({}, {
  __index = __real_G,
  __newindex = readonly_error,
  __pairs = function() return next, __real_G, nil end,
  __metatable = false,
})
__protected[__proxy_G] = true
__real_G._G = __proxy_G
local __rawset = rawset
rawset = function(t, k, v)
  if __protected[t] then error('Attempt to modify a readonly table', 2) end
  return __rawset(t, k, v)
end
setmetatable(__real_G, {
  __index = function(_, name) error("Script attempted to access nonexistent global variable '" .. tostring(name) .. "'", 2) end,
  __newindex = readonly_error,
  __metatable = false,
})
-- Chunks loaded from now on (scripts, function libraries, loadstring) get the proxy as their _ENV.
__debug.getregistry()[2] = __proxy_G
debug = nil
`;
