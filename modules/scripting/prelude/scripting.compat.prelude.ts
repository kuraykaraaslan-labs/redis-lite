/**
 * Lua prelude, part 1 of 8: Lua 5.1 compatibility. Captures the Lua 5.4 builtins the later parts use (as locals, before
 * the sandbox prunes the globals), and defines the 5.1 behaviours scripts can observe:
 * - numbers print with "%.14g" (tostring, string.format('%s'), table.concat);
 * - `error(42)` gets a position like a string, `pcall` / `xpcall` / `coroutine.resume` hand out 5.1 error texts;
 * - `string.format` truncates non-integral numbers for %d / %i / %c / %o / %u / %x / %X, `%q` quotes numbers,
 *   `string.rep` has no separator;
 * - `setfenv` / `getfenv` (over `_ENV` upvalues), `newproxy`, `gcinfo`, `unpack`, `loadstring`, the 5.1 math and table
 *   functions (atan2, cosh, frexp, ldexp, log10, mod, pow, foreach, foreachi, getn, maxn, setn…);
 * - `coroutine.running()` is nil in the script itself (5.1 main thread).
 *
 * Errors of library functions written in Lua carry the caller's position, like luaL_error in a C library
 * (`user_script:1: bad argument #1 to 'band' …`): `lib_error` finds the caller above the prelude's frames. The heavier
 * functions (error, cjson, cmsgpack, struct) are wrapped with `__cwrap`, a C trampoline registered by the engine, so that
 * their caller's frame survives a tail call (`return cjson.encode(x)`) as it does for a C function; the trampoline
 * costs a JS round trip per call, so the light, hot functions (bit, string.format…) are left plain.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_COMPAT = String.raw`
-- ---------- captured builtins (the sandbox prunes the globals: later parts use these locals) ----------
local __debug = debug
local __getinfo, __getupvalue, __upvaluejoin = debug.getinfo, debug.getupvalue, debug.upvaluejoin
local __type, __select, __error, __tostring, __tonumber = type, select, error, tostring, tonumber
local __pcall, __xpcall, __next, __pairs, __ipairs = pcall, xpcall, next, pairs, ipairs
local __rawget, __rawset, __setmetatable, __getmetatable = rawget, rawset, setmetatable, getmetatable
local __load, __collectgarbage = load, collectgarbage
local sformat, sfind, ssub, sbyte, schar, srep, sgsub, smatch, slower = string.format, string.find, string.sub, string.byte, string.char, string.rep, string.gsub, string.match, string.lower
local spack, sunpack = string.pack, string.unpack
local tconcat, tunpack, tpack, tsort = table.concat, table.unpack, table.pack, table.sort
local mfloor, mceil, mhuge, mtointeger, mtype, mexp, mlog = math.floor, math.ceil, math.huge, math.tointeger, math.type, math.exp, math.log
local mfmod, mrandom, mrandomseed = math.fmod, math.random, math.randomseed
local corunning, coresume, cocreate = coroutine.running, coroutine.resume, coroutine.create
local __cwrap, __to51, __newproxy = __rl_cwrap, __rl_to51, __rl_newproxy
__rl_cwrap, __rl_to51, __rl_newproxy = nil, nil, nil
-- Builtins called as fields: an argument error then names them like Lua 5.1 does ('format', not 'sformat').
local B = { format = sformat, rep = srep, concat = tconcat, setmetatable = __setmetatable, tonumber = tonumber }

-- Lua 5.1 has only doubles and prints them with "%.14g": tostring(1e15 integer) is "1e+15", tostring(10/2) is "5".
-- A __tostring on the number metatable covers tostring() and string.format('%s'); the '..' operator converts numbers
-- in C (Lua 5.4 rules: 10/2 .. '' is "5.0") and cannot be hooked.
local function num2str(n) return sformat('%.14g', n) end
__debug.setmetatable(0, { __tostring = num2str })

-- Floats with an integral value become integers, so '..' prints them the way Lua 5.1 does ("5", not "5.0"). -0 stays a
-- float: tostring(-0) must print "-0".
local function normnum(v)
  if mtype(v) == 'float' and v == v and (v ~= 0 or 1 / v > 0) then
    local i = mtointeger(v)
    if i then return i end
  end
  return v
end

-- ---------- errors raised by library functions ----------
-- "chunk:line: " of the caller of the library function running, like luaL_where(L, 1) seen from a C library: the
-- first frame above the prelude's frames (and above the C trampoline of a __cwrap'd function). '' when that caller is
-- a C function (pcall); "prelude:0: " when it is gone (the library function was tail-called by the script's main
-- chunk): the engine then puts the position of the innermost frame of user code.
local function caller_where()
  local level, tail = 2, false
  while true do
    local info = __getinfo(level, 'Sltf')
    if info == nil then return tail and 'prelude:0: ' or '' end
    if info.source == '=prelude' then
      tail = info.istailcall
    elseif info.what == 'C' then
      if __getupvalue(info.func, 1) == nil then return '' end
      tail = false
    elseif info.currentline > 0 then
      return info.short_src .. ':' .. info.currentline .. ': '
    else
      return ''
    end
    level = level + 1
  end
end
local function lib_error(msg) __error(caller_where() .. msg, 0) end
-- luaL_checknumber / luaL_checkstring texts.
local function typename_at(n, i, v) if i > n then return 'no value' end return __type(v) end
local function arg_error(fname, i, msg) lib_error(sformat("bad argument #%d to '%s' (%s)", i, fname, msg)) end
-- luaL_checknumber (numbers and numeric strings) / luaL_checkint (truncated) of argument #i of n.
local function checknum(fname, n, i, v)
  local x = (__type(v) == 'number' or __type(v) == 'string') and __tonumber(v) or nil
  if x == nil then arg_error(fname, i, 'number expected, got ' .. typename_at(n, i, v)) end
  return x
end
local function checkint(fname, n, i, v)
  local x = checknum(fname, n, i, v)
  if x ~= x or x == mhuge or x == -mhuge then return 0 end
  return mtointeger(x >= 0 and mfloor(x) or mceil(x)) or 0
end

-- error(): Lua 5.1 adds the position to numbers too (lua_isstring), and the message of error(42) is "user_script:1: 42".
error = __cwrap(function(msg, level)
  level = level == nil and 1 or __tonumber(level) or 1
  if __type(msg) == 'number' then
    msg = num2str(msg)
    if level > 0 then
      local info = __getinfo(level + 2, 'Sl')
      if info ~= nil and info.currentline > 0 then msg = info.short_src .. ':' .. info.currentline .. ': ' .. msg end
    end
    __error(msg, 0)
  end
  -- impl (1) <- trampoline (2) <- caller: the caller's level 1 is level 3 here
  __error(msg, level > 0 and level + 2 or 0)
end)

-- pcall / xpcall / coroutine.resume: Lua 5.1 texts for the runtime errors they catch.
local function to51_result(ok, ...)
  if ok then return true, ... end
  local e = ...
  if __type(e) == 'string' then e = __to51(sgsub(e, '^prelude:%d+: ', '')) end
  return false, e
end
pcall = function(f, ...) return to51_result(__pcall(f, ...)) end
xpcall = function(f, handler)
  return __xpcall(f, function(e)
    if __type(e) == 'string' then e = __to51(e) end
    return handler(e)
  end)
end
-- The threads the engine runs scripts in: coroutine.running() answers nil there (the 5.1 main thread).
local __script_threads = __setmetatable({}, { __mode = 'k' })
local co51 = {
  create = cocreate,
  resume = function(co, ...) return to51_result(coresume(co, ...)) end,
  running = function()
    local co, main = corunning()
    if main or __script_threads[co] then return nil end
    return co
  end,
  status = coroutine.status,
  wrap = coroutine.wrap,
  yield = coroutine.yield,
}

-- string.format: non-integral numbers are truncated for the integer conversions (5.1 casts to long), %q quotes the
-- "%.14g" text of a number, a missing argument is "no value".
local INTEGER_CONVERSIONS = { d = true, i = true, c = true, o = true, u = true, x = true, X = true }
local function format51(fmt, ...)
  local n = __select('#', ...)
  -- fast path: no float argument and no %q, and 5.4 formats the call without error
  local plain = true
  for k = 1, n do
    local t = mtype((__select(k, ...)))
    if t == 'float' or (t == 'integer' and __type(fmt) == 'string' and sfind(fmt, '%q', 1, true)) then
      plain = false
      break
    end
  end
  if plain then
    local ok, r = __pcall(sformat, fmt, ...)
    if ok then return r end
  end
  if __type(fmt) == 'string' and sfind(fmt, '%', 1, true) then
    local args
    local argi, i = 0, 1
    while true do
      local p = sfind(fmt, '%', i, true)
      if p == nil then break end
      if sbyte(fmt, p + 1) == 37 then
        i = p + 2
      else
        argi = argi + 1
        local _, e = sfind(fmt, '^[-+ #0]*%d*%.?%d*', p + 1)
        local conv = ssub(fmt, e + 1, e + 1)
        if argi > n and conv ~= '' then arg_error('format', argi + 1, 'no value') end
        local v = (__select(argi, ...))
        if INTEGER_CONVERSIONS[conv] and mtype(v) == 'float' and not mtointeger(v) and v == v and v ~= mhuge and v ~= -mhuge then
          args = args or { ... }
          args[argi] = v >= 0 and mfloor(v) or mceil(v)
        elseif conv == 'q' and __type(v) == 'number' then
          args = args or { ... }
          args[argi] = num2str(v)
        end
        i = e + 2
      end
    end
    if args then
      local r = B.format(fmt, tunpack(args, 1, n))
      return r
    end
  end
  local r = B.format(fmt, ...)
  return r
end
-- string.rep has no separator argument in 5.1.
local function rep51(...)
  local r
  if __select('#', ...) > 2 then
    local s, n = ...
    r = B.rep(s, n)
  else
    r = B.rep(...)
  end
  return r
end
-- table.concat prints numbers with "%.14g" (5.4 would print 2.0 as "2.0").
local function concat51(t, sep, i, j)
  if __type(t) == 'table' then
    local last = j or #t
    for k = i or 1, last do
      if mtype(__rawget(t, k)) == 'float' then
        local copy = {}
        for m = i or 1, last do
          local v = t[m]
          copy[#copy + 1] = mtype(v) == 'float' and num2str(v) or v
        end
        local r = B.concat(copy, sep)
        return r
      end
    end
  end
  local r = B.concat(t, sep, i, j)
  return r
end

-- ---------- setfenv / getfenv over _ENV upvalues ----------
local function env_index(f)
  for i = 1, 255 do
    local name = __getupvalue(f, i)
    if name == nil then return nil end
    if name == '_ENV' then return i end
  end
  return nil
end
local __globals = nil -- the scripts' global table, set by the sandbox
local function fenv_target(f, fname)
  if __type(f) == 'number' then
    if f < 0 then lib_error("bad argument #1 to '" .. fname .. "' (level must be non-negative)") end
    if f == 0 then return nil end
    local info = __getinfo(f + 3, 'f')
    if info == nil then lib_error("bad argument #1 to '" .. fname .. "' (invalid level)") end
    return info.func
  end
  if f == nil then
    local info = __getinfo(4, 'f')
    return info and info.func
  end
  if __type(f) ~= 'function' then arg_error(fname, 1, 'number expected, got ' .. __type(f)) end
  return f
end
local getfenv51 = __cwrap(function(f)
  f = fenv_target(f, 'getfenv')
  if f == nil then return __globals end
  local i = env_index(f)
  if i == nil then return __globals end
  local _, env = __getupvalue(f, i)
  return env
end)
local setfenv51 = __cwrap(function(f, env)
  if __type(env) ~= 'table' then arg_error('setfenv', 2, 'table expected, got ' .. typename_at(2, 2, env)) end
  local target = fenv_target(f, 'setfenv')
  if target == nil then return nil end
  local info = __getinfo(target, 'S')
  if info.what == 'C' then lib_error("'setfenv' cannot change environment of given object") end
  local i = env_index(target)
  -- a fresh upvalue: only this function sees the new environment (5.4 shares _ENV between the closures of a chunk)
  if i ~= nil then __upvaluejoin(target, i, function() return env end, 1) end
  if __type(f) == 'number' then return nil end
  return target
end)

-- ---------- the other 5.1 functions ----------
local math51 = {
  atan2 = math.atan,
  cosh = function(x) return (mexp(x) + mexp(-x)) / 2 end,
  sinh = function(x) return (mexp(x) - mexp(-x)) / 2 end,
  tanh = function(x)
    if x > 20 then return 1.0 end
    if x < -20 then return -1.0 end
    local a, b = mexp(x), mexp(-x)
    return (a - b) / (a + b)
  end,
  frexp = function(x)
    if x == 0 or x ~= x or x == mhuge or x == -mhuge then return x, 0 end
    local e = mfloor(mlog(x < 0 and -x or x, 2)) + 1
    local m = x / 2.0 ^ e
    local am = m < 0 and -m or m
    if am >= 1 then m, e = m / 2, e + 1 elseif am < 0.5 then m, e = m * 2, e - 1 end
    return m, e
  end,
  ldexp = function(m, e) return m * 2.0 ^ e end,
  log10 = function(x) return mlog(x, 10) end,
  log = function(x) return mlog(x) end,
  -- 5.1 numbers are doubles: fmod(x, 0) is nan, not an error
  fmod = function(a, b)
    if b == 0 then return mfmod(a + 0.0, 0.0) end
    local r = mfmod(a, b)
    return r
  end,
  max = function(...)
    local n = __select('#', ...)
    local m = checknum('max', n, 1, (...))
    for i = 2, n do
      local v = checknum('max', n, i, (__select(i, ...)))
      if v > m then m = v end
    end
    return m
  end,
  min = function(...)
    local n = __select('#', ...)
    local m = checknum('min', n, 1, (...))
    for i = 2, n do
      local v = checknum('min', n, i, (__select(i, ...)))
      if v < m then m = v end
    end
    return m
  end,
  -- ceil(-0.5) is -0 (a double)
  ceil = function(x)
    local r = mceil(x)
    if r == 0 and x < 0 then return -0.0 end
    return r
  end,
  -- the 5.1 interface (the generator is Lua 5.4's, not Redis's)
  random = function(...)
    local n = __select('#', ...)
    local r = mrandom()
    if n == 0 then return r end
    local m = checkint('random', n, 1, (...))
    if n == 1 then
      if m < 1 then arg_error('random', 1, 'interval is empty') end
      return mfloor(r * m) + 1
    end
    local u = checkint('random', n, 2, (__select(2, ...)))
    if n > 2 then lib_error('wrong number of arguments') end
    if m > u then arg_error('random', 2, 'interval is empty') end
    return mfloor(r * (u - m + 1)) + m
  end,
  randomseed = function(...)
    mrandomseed(checkint('randomseed', __select('#', ...), 1, (...)))
  end,
  pow = function(a, b) return a ^ b end,
}
local table51 = {
  -- 5.1: raw accesses, any position (the array grows), no "position out of bounds" error
  insert = function(...)
    local n = __select('#', ...)
    local t, a, b = ...
    if __type(t) ~= 'table' then arg_error('insert', 1, 'table expected, got ' .. typename_at(n, 1, t)) end
    local e = #t + 1
    if n == 2 then
      __rawset(t, e, a)
      return
    end
    if n ~= 3 then lib_error("wrong number of arguments to 'insert'") end
    local pos = checkint('insert', n, 2, a)
    if pos > e then e = pos end
    for i = e, pos + 1, -1 do __rawset(t, i, __rawget(t, i - 1)) end
    __rawset(t, pos, b)
  end,
  remove = function(...)
    local n = __select('#', ...)
    local t, pos = ...
    if __type(t) ~= 'table' then arg_error('remove', 1, 'table expected, got ' .. typename_at(n, 1, t)) end
    local e = #t
    if e == 0 then return end
    pos = pos == nil and e or checkint('remove', n, 2, pos)
    if pos < 1 or pos > e then return end
    local v = __rawget(t, pos)
    for i = pos, e - 1 do __rawset(t, i, __rawget(t, i + 1)) end
    __rawset(t, e, nil)
    return v
  end,
  getn = function(t) return #t end,
  setn = function() lib_error("'setn' is obsolete") end,
  maxn = function(t)
    local max = 0
    for k in __pairs(t) do
      if __type(k) == 'number' and k > max then max = k end
    end
    return max
  end,
  foreach = function(t, f)
    for k, v in __pairs(t) do
      local r = f(k, v)
      if r ~= nil then return r end
    end
  end,
  foreachi = function(t, f)
    for i = 1, #t do
      local r = f(i, t[i])
      if r ~= nil then return r end
    end
  end,
}
math51.mod = math51.fmod
local function gcinfo51() return mfloor(__collectgarbage('count')) end

-- tonumber: strtod also reads inf / nan; numbers come back as 5.1 would print them ("100", not "100.0").
local function tonumber51(...)
  local r = B.tonumber(...)
  if r == nil then
    local v, base = ...
    if base == nil and __type(v) == 'string' then
      local sign, word = smatch(slower(v), '^%s*([-+]?)(%a+)%s*$')
      if word == 'inf' or word == 'infinity' then r = mhuge
      elseif word == 'nan' then r = -(0 / 0) end
      if r ~= nil and sign == '-' then r = -r end
    end
    return r
  end
  return normnum(r)
end
-- load takes a function only in 5.1 (loadstring takes the string); compile errors in the 5.1 wording.
local function compiled(f, e)
  if f == nil and __type(e) == 'string' then e = __to51(e) end
  return f, e
end
local function load51(...)
  local f = ...
  if __type(f) ~= 'function' then arg_error('load', 1, 'function expected, got ' .. typename_at(__select('#', ...), 1, f)) end
  return compiled(__load(...))
end
local function loadstring51(s, chunkname) return compiled(__load(s, chunkname)) end

`;
