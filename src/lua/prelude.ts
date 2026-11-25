/**
 * Lua prelude run once per Lua state. Makes Lua 5.4 look like the Lua 5.1 that Redis embeds, and provides the libraries
 * Redis scripts expect: `redis.*`, `cjson`, `cmsgpack`, `bit`. Everything here is plain Lua so it works on byte strings.
 */
export const LUA_PRELUDE = String.raw`
-- ---------- sandbox and Lua 5.1 compatibility ----------
local __clock = os.clock
local __debug = debug
local sformat = string.format
os = { clock = __clock }
io = nil
package = nil
require = nil
dofile = nil
loadfile = nil
unpack = table.unpack
loadstring = load
table.getn = function(t) return #t end
math.pow = function(a, b) return a ^ b end
math.mod = math.fmod
string.gfind = string.gmatch

-- Lua 5.1 has only doubles and prints them with "%.14g": tostring(1e15 integer) is "1e+15", tostring(10/2) is "5".
-- A __tostring on the number metatable covers tostring() and string.format('%s'); the '..' operator and table.concat
-- convert numbers in C (Lua 5.4 rules) and cannot be hooked.
local function num2str(n) return sformat('%.14g', n) end
__debug.setmetatable(0, { __tostring = num2str })

-- ---------- redis ----------
local __call = __redis_call
redis = {}
redis.call = function(...)
  local ok, r = __call(...)
  if ok then return r end
  error(r, 0)
end
redis.pcall = function(...)
  local _, r = __call(...)
  return r
end
redis.error_reply = function(msg)
  if type(msg) ~= 'string' then error('wrong number or type of arguments', 2) end
  return { err = msg }
end
redis.status_reply = function(msg)
  if type(msg) ~= 'string' then error('wrong number or type of arguments', 2) end
  return { ok = msg }
end
redis.sha1hex = __redis_sha1hex
redis.log = function(level, ...) end
redis.LOG_DEBUG, redis.LOG_VERBOSE, redis.LOG_NOTICE, redis.LOG_WARNING = 0, 1, 2, 3
local __setresp = __redis_setresp
redis.setresp = function(...)
  if select('#', ...) ~= 1 then error({ err = 'ERR redis.setresp() requires one argument.' }) end
  local v = tonumber((...))
  if v ~= 2 and v ~= 3 then error({ err = 'ERR RESP version must be 2 or 3.' }) end
  __setresp(v)
end
redis.set_repl = function(v) end
redis.replicate_commands = function() return true end
redis.REPL_NONE, redis.REPL_AOF, redis.REPL_SLAVE, redis.REPL_REPLICA, redis.REPL_ALL = 0, 1, 2, 2, 3
redis.breakpoint = function() return false end
redis.debug = function(...) end
redis.acl_check_cmd = function() return true end
redis.REDIS_VERSION = '8.8.4'

-- ---------- Redis Functions (FUNCTION LOAD / FCALL) ----------
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

-- ---------- bit (LuaBitOp, 32-bit) ----------
local function tobit(x)
  x = math.tointeger(x) or math.floor(x)
  x = x & 0xffffffff
  if x >= 0x80000000 then x = x - 0x100000000 end
  return x
end
bit = {
  tobit = tobit,
  bnot = function(a) return tobit(~a) end,
  band = function(a, ...) local r = a for _, v in ipairs({...}) do r = r & v end return tobit(r) end,
  bor = function(a, ...) local r = a for _, v in ipairs({...}) do r = r | v end return tobit(r) end,
  bxor = function(a, ...) local r = a for _, v in ipairs({...}) do r = r ~ v end return tobit(r) end,
  lshift = function(a, n) return tobit((a & 0xffffffff) << (n & 31)) end,
  rshift = function(a, n) return tobit((a & 0xffffffff) >> (n & 31)) end,
  arshift = function(a, n) return tobit(tobit(a) >> (n & 31) | (tobit(a) < 0 and ~(0xffffffff >> (n & 31)) or 0)) end,
  rol = function(a, n) a = a & 0xffffffff n = n & 31 return tobit((a << n) | (a >> (32 - n))) end,
  ror = function(a, n) a = a & 0xffffffff n = n & 31 return tobit((a >> n) | (a << (32 - n))) end,
  bswap = function(a) a = a & 0xffffffff return tobit(((a & 0xff) << 24) | ((a & 0xff00) << 8) | ((a >> 8) & 0xff00) | (a >> 24)) end,
  tohex = function(a, n)
    n = n == nil and 8 or tobit(n)
    local conv = 'x'
    if n < 0 then n = -n conv = 'X' end
    if n > 8 then n = 8 end
    if n == 0 then return '' end
    return sformat('%0' .. n .. conv, (tobit(a) & 0xffffffff) & ((1 << (4 * n)) - 1))
  end,
}

-- Floats with an integral value become integers, so tostring() and .. print them the way Lua 5.1 does ("5", not "5.0").
local function normnum(v)
  if math.type(v) == 'float' then
    local i = math.tointeger(v)
    if i then return i end
  end
  return v
end

-- ---------- cjson ----------
cjson = {}
cjson.null = setmetatable({}, { __tostring = function() return 'null' end })

local escapes = { ['/'] = '\\/', ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function encode_string(s)
  return '"' .. s:gsub('[%c"\\/]', function(c)
    return escapes[c] or string.format('\\u%04x', c:byte())
  end) .. '"'
end

local function is_array(t)
  local n = 0
  for k in pairs(t) do
    if math.type(k) ~= 'integer' or k < 1 then return false end
    if k > n then n = k end
  end
  if n == 0 then return false end
  for i = 1, n do if t[i] == nil then return false end end
  return true, n
end

local encode
encode = function(v, depth)
  depth = depth or 0
  if depth > 1000 then error('Cannot serialise, excessive nesting (1001)') end
  local t = type(v)
  if v == nil or v == cjson.null then return 'null' end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then error('Cannot serialise number: must not be NaN or Inf') end
    return sformat('%.14g', v)
  end
  if t == 'string' then return encode_string(v) end
  if t == 'table' then
    local arr, n = is_array(v)
    local out = {}
    if arr then
      for i = 1, n do out[i] = encode(v[i], depth + 1) end
      return '[' .. table.concat(out, ',') .. ']'
    end
    for k, val in pairs(v) do
      local kt = type(k)
      if kt ~= 'string' and kt ~= 'number' then error('Cannot serialise ' .. kt .. ': table key must be a number or string') end
      out[#out + 1] = encode_string(kt == 'number' and num2str(k) or k) .. ':' .. encode(val, depth + 1)
    end
    return '{' .. table.concat(out, ',') .. '}'
  end
  error('Cannot serialise ' .. t .. ': type not supported')
end
cjson.encode = function(v) return encode(v, 0) end

local function decode_error(s, i, msg)
  error(string.format('Expected %s but found invalid token at character %d', msg, i))
end

local decode_value
local function skip(s, i)
  local _, e = s:find('^[ \n\r\t]*', i)
  return e + 1
end

local function decode_string(s, i)
  local out = {}
  local j = i + 1
  while true do
    local c = s:sub(j, j)
    if c == '' then decode_error(s, j, 'string end') end
    if c == '"' then return table.concat(out), j + 1 end
    if c == '\\' then
      local n = s:sub(j + 1, j + 1)
      local map = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }
      if map[n] then
        out[#out + 1] = map[n]
        j = j + 2
      elseif n == 'u' then
        local cp = tonumber(s:sub(j + 2, j + 5), 16)
        if not cp then decode_error(s, j, 'unicode escape') end
        j = j + 6
        if cp >= 0xD800 and cp <= 0xDBFF and s:sub(j, j + 1) == '\\u' then
          local lo = tonumber(s:sub(j + 2, j + 5), 16)
          if lo and lo >= 0xDC00 and lo <= 0xDFFF then
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
            j = j + 6
          end
        end
        out[#out + 1] = utf8.char(cp)
      else
        decode_error(s, j, 'escape')
      end
    else
      out[#out + 1] = c
      j = j + 1
    end
  end
end

decode_value = function(s, i)
  i = skip(s, i)
  local c = s:sub(i, i)
  if c == '{' then
    local t = {}
    i = skip(s, i + 1)
    if s:sub(i, i) == '}' then return t, i + 1 end
    while true do
      i = skip(s, i)
      if s:sub(i, i) ~= '"' then decode_error(s, i, 'object key string') end
      local k
      k, i = decode_string(s, i)
      i = skip(s, i)
      if s:sub(i, i) ~= ':' then decode_error(s, i, 'colon') end
      local v
      v, i = decode_value(s, i + 1)
      t[k] = v
      i = skip(s, i)
      local d = s:sub(i, i)
      if d == '}' then return t, i + 1 end
      if d ~= ',' then decode_error(s, i, 'comma or object end') end
      i = i + 1
    end
  elseif c == '[' then
    local t = {}
    i = skip(s, i + 1)
    if s:sub(i, i) == ']' then return t, i + 1 end
    local n = 0
    while true do
      local v
      v, i = decode_value(s, i)
      n = n + 1
      t[n] = v
      i = skip(s, i)
      local d = s:sub(i, i)
      if d == ']' then return t, i + 1 end
      if d ~= ',' then decode_error(s, i, 'comma or array end') end
      i = i + 1
    end
  elseif c == '"' then
    return decode_string(s, i)
  elseif s:sub(i, i + 3) == 'true' then
    return true, i + 4
  elseif s:sub(i, i + 4) == 'false' then
    return false, i + 5
  elseif s:sub(i, i + 3) == 'null' then
    return cjson.null, i + 4
  else
    local num = s:match('^-?%d+%.?%d*[eE]?[-+]?%d*', i)
    if not num or num == '' then decode_error(s, i, 'value') end
    local v = tonumber(num)
    if v == nil then decode_error(s, i, 'number') end
    return normnum(v), i + #num
  end
end

cjson.decode = function(s)
  if type(s) ~= 'string' then error('bad argument #1 to \'decode\' (string expected)') end
  local v, i = decode_value(s, 1)
  i = skip(s, i)
  if i <= #s then decode_error(s, i, 'the end') end
  return v
end
cjson.encode_keep_buffer = function() end
cjson.encode_max_depth = function() end
cjson.decode_max_depth = function() end
cjson.encode_invalid_numbers = function() end
cjson.decode_invalid_numbers = function() end
cjson.encode_sparse_array = function() end
cjson.encode_empty_table_as_object = function() end

-- ---------- cmsgpack ----------
cmsgpack = {}
local spack, sunpack = string.pack, string.unpack

local function mp_decode(s, i)
  local b = s:byte(i)
  if b == nil then error('Missing bytes in input.') end
  if b <= 0x7f then return b, i + 1 end
  if b >= 0xe0 then return b - 0x100, i + 1 end
  if b >= 0x80 and b <= 0x8f then
    local t = {}
    i = i + 1
    for _ = 1, b - 0x80 do
      local k, v
      k, i = mp_decode(s, i)
      v, i = mp_decode(s, i)
      if k ~= nil then t[k] = v end
    end
    return t, i
  end
  if b >= 0x90 and b <= 0x9f then
    local t = {}
    i = i + 1
    for n = 1, b - 0x90 do t[n], i = mp_decode(s, i) end
    return t, i
  end
  if b >= 0xa0 and b <= 0xbf then
    local len = b - 0xa0
    return s:sub(i + 1, i + len), i + 1 + len
  end
  if b == 0xc0 then return nil, i + 1 end
  if b == 0xc2 then return false, i + 1 end
  if b == 0xc3 then return true, i + 1 end
  if b == 0xc4 or b == 0xd9 then local len = s:byte(i + 1) return s:sub(i + 2, i + 1 + len), i + 2 + len end
  if b == 0xc5 or b == 0xda then local len = sunpack('>I2', s, i + 1) return s:sub(i + 3, i + 2 + len), i + 3 + len end
  if b == 0xc6 or b == 0xdb then local len = sunpack('>I4', s, i + 1) return s:sub(i + 5, i + 4 + len), i + 5 + len end
  if b == 0xca then local v = sunpack('>f', s, i + 1) return normnum(v), i + 5 end
  if b == 0xcb then local v = sunpack('>d', s, i + 1) return normnum(v), i + 9 end
  if b == 0xcc then return s:byte(i + 1), i + 2 end
  if b == 0xcd then return (sunpack('>I2', s, i + 1)), i + 3 end
  if b == 0xce then return (sunpack('>I4', s, i + 1)), i + 5 end
  if b == 0xcf then return (sunpack('>i8', s, i + 1)), i + 9 end
  if b == 0xd0 then return (sunpack('>i1', s, i + 1)), i + 2 end
  if b == 0xd1 then return (sunpack('>i2', s, i + 1)), i + 3 end
  if b == 0xd2 then return (sunpack('>i4', s, i + 1)), i + 5 end
  if b == 0xd3 then return (sunpack('>i8', s, i + 1)), i + 9 end
  if b == 0xdc or b == 0xdd then
    local n
    if b == 0xdc then n = sunpack('>I2', s, i + 1) i = i + 3 else n = sunpack('>I4', s, i + 1) i = i + 5 end
    local t = {}
    for k = 1, n do t[k], i = mp_decode(s, i) end
    return t, i
  end
  if b == 0xde or b == 0xdf then
    local n
    if b == 0xde then n = sunpack('>I2', s, i + 1) i = i + 3 else n = sunpack('>I4', s, i + 1) i = i + 5 end
    local t = {}
    for _ = 1, n do
      local k, v
      k, i = mp_decode(s, i)
      v, i = mp_decode(s, i)
      if k ~= nil then t[k] = v end
    end
    return t, i
  end
  -- fixext / ext: skip payload, decode as nil
  local extlen = ({ [0xd4] = 1, [0xd5] = 2, [0xd6] = 4, [0xd7] = 8, [0xd8] = 16 })[b]
  if extlen then return nil, i + 2 + extlen end
  if b == 0xc7 then local len = s:byte(i + 1) return nil, i + 3 + len end
  if b == 0xc8 then local len = sunpack('>I2', s, i + 1) return nil, i + 4 + len end
  if b == 0xc9 then local len = sunpack('>I4', s, i + 1) return nil, i + 6 + len end
  error(string.format('Unsupported msgpack type 0x%02x', b))
end

cmsgpack.unpack = function(s)
  local out, n, i = {}, 0, 1
  while i <= #s do
    n = n + 1
    out[n], i = mp_decode(s, i)
  end
  return table.unpack(out, 1, n)
end
cmsgpack.unpack_one = function(s, offset)
  local v, i = mp_decode(s, (offset or 0) + 1)
  return i - 1 >= #s and -1 or i - 1, v
end

local mp_encode
mp_encode = function(v)
  local t = type(v)
  if v == nil then return '\192' end
  if t == 'boolean' then return v and '\195' or '\194' end
  if t == 'number' then
    local iv = math.tointeger(v)
    if iv then
      if iv >= 0 then
        if iv <= 0x7f then return string.char(iv) end
        if iv <= 0xff then return '\204' .. string.char(iv) end
        if iv <= 0xffff then return '\205' .. spack('>I2', iv) end
        if iv <= 0xffffffff then return '\206' .. spack('>I4', iv) end
        return '\207' .. spack('>i8', iv)
      end
      if iv >= -32 then return string.char(iv + 0x100) end
      if iv >= -128 then return '\208' .. spack('>i1', iv) end
      if iv >= -32768 then return '\209' .. spack('>i2', iv) end
      if iv >= -2147483648 then return '\210' .. spack('>i4', iv) end
      return '\211' .. spack('>i8', iv)
    end
    -- lua_cmsgpack: a double that survives the trip through float32 is packed as float32 (0xca).
    if v == v and sunpack('>f', spack('>f', v)) == v then return '\202' .. spack('>f', v) end
    return '\203' .. spack('>d', v)
  end
  if t == 'string' then
    local n = #v
    if n < 32 then return string.char(0xa0 + n) .. v end
    if n <= 0xff then return '\217' .. string.char(n) .. v end
    if n <= 0xffff then return '\218' .. spack('>I2', n) .. v end
    return '\219' .. spack('>I4', n) .. v
  end
  if t == 'table' then
    local arr, n = is_array(v)
    local parts = {}
    if arr or next(v) == nil then
      n = n or 0
      for i = 1, n do parts[i] = mp_encode(v[i]) end
      local head = n < 16 and string.char(0x90 + n) or (n <= 0xffff and '\220' .. spack('>I2', n) or '\221' .. spack('>I4', n))
      return head .. table.concat(parts)
    end
    local count = 0
    for k, val in pairs(v) do
      count = count + 1
      parts[#parts + 1] = mp_encode(k) .. mp_encode(val)
    end
    local head = count < 16 and string.char(0x80 + count) or (count <= 0xffff and '\222' .. spack('>I2', count) or '\223' .. spack('>I4', count))
    return head .. table.concat(parts)
  end
  return '\192'
end

cmsgpack.pack = function(...)
  local parts = {}
  for i = 1, select('#', ...) do parts[i] = mp_encode((select(i, ...))) end
  return table.concat(parts)
end

-- ---------- struct (Roberto Ierusalimschy's struct library, as bundled with Redis) ----------
struct = {}
local STRUCT_MAXINTSIZE = 32
local STRUCT_MAXALIGN = 8
-- sizeof on 64-bit Linux, where Redis runs: long and size_t are 8 bytes.
local struct_sizes = { b = 1, B = 1, h = 2, H = 2, l = 8, L = 8, T = 8, f = 4, d = 8, x = 1 }

local function struct_getnum(fmt, i, df)
  local digits = fmt:match('^%d+', i)
  if not digits then return df, i end
  local a = tonumber(digits)
  if a > 2147483647 then error('integral size overflow', 3) end
  return math.tointeger(a), i + #digits
end

-- Returns opt, size, next index.
local function struct_optsize(fmt, i)
  local opt = fmt:sub(i, i)
  i = i + 1
  local size = struct_sizes[opt]
  if size then return opt, size, i end
  if opt == 'c' then
    size, i = struct_getnum(fmt, i, 1)
    return opt, size, i
  end
  if opt == 'i' or opt == 'I' then
    size, i = struct_getnum(fmt, i, 4)
    if size > STRUCT_MAXINTSIZE then error(sformat('integral size %d is larger than limit of %d', size, STRUCT_MAXINTSIZE), 3) end
    return opt, size, i
  end
  return opt, 0, i
end

local function struct_toalign(len, h, opt, size)
  if size == 0 or opt == 'c' then return 0 end
  if size > h.align then size = h.align end
  return (size - (len & (size - 1))) & (size - 1)
end

local function struct_control(fmt, i, opt, h, fname)
  if opt == ' ' then return i end
  if opt == '>' then h.little = false return i end
  if opt == '<' then h.little = true return i end
  if opt == '!' then
    local a
    a, i = struct_getnum(fmt, i, STRUCT_MAXALIGN)
    if a == 0 or (a & (a - 1)) ~= 0 then error(sformat('alignment %d is not a power of 2', a), 3) end
    h.align = a
    return i
  end
  error(sformat("bad argument #1 to '%s' (invalid format option '%s')", fname, opt), 3)
end

local function struct_putint(n, size, little)
  local v
  if math.type(n) == 'integer' then v = n
  elseif n < 0 then v = math.tointeger(math.ceil(n)) or math.mininteger
  else v = math.tointeger(math.floor(n)) or (n >= 2^63 and math.tointeger(n - 2^64) or 0) end
  local bytes = {}
  for k = 1, size do
    bytes[k] = v & 0xff
    v = v >> 8
  end
  if not little then
    local r = {}
    for k = 1, size do r[k] = bytes[size + 1 - k] end
    bytes = r
  end
  return string.char(table.unpack(bytes))
end

local function struct_getint(data, pos, size, little, signed)
  local l = 0
  for k = 0, size - 1 do
    local idx = little and (pos + size - 1 - k) or (pos + k)
    l = (l << 8) | data:byte(idx)
  end
  if signed then
    local bits = size * 8
    if bits < 64 then
      local mask = -1 << (bits - 1)
      if l & mask ~= 0 then l = l | mask end
    end
    return l
  end
  if l < 0 then return l + 2^64 end
  return l
end

struct.pack = function(fmt, ...)
  if type(fmt) ~= 'string' and type(fmt) ~= 'number' then error("bad argument #1 to 'pack' (string expected, got " .. type(fmt) .. ')', 2) end
  fmt = tostring(fmt)
  local h = { little = true, align = 1 }
  local args = table.pack(...)
  local arg = 1
  local out = {}
  local total = 0
  local i = 1
  while i <= #fmt do
    local opt, size
    opt, size, i = struct_optsize(fmt, i)
    local toalign = struct_toalign(total, h, opt, size)
    total = total + toalign
    if toalign > 0 then out[#out + 1] = string.rep('\0', toalign) end
    if opt:match('^[bBhHlLTiI]$') then
      local n = tonumber(args[arg])
      if n == nil then error(sformat("bad argument #%d to 'pack' (number expected, got %s)", arg + 1, type(args[arg])), 2) end
      arg = arg + 1
      out[#out + 1] = struct_putint(n, size, h.little)
    elseif opt == 'x' then
      out[#out + 1] = '\0'
    elseif opt == 'f' or opt == 'd' then
      local n = tonumber(args[arg])
      if n == nil then error(sformat("bad argument #%d to 'pack' (number expected, got %s)", arg + 1, type(args[arg])), 2) end
      arg = arg + 1
      out[#out + 1] = spack((h.little and '<' or '>') .. opt, n)
    elseif opt == 'c' or opt == 's' then
      local str = args[arg]
      if type(str) == 'number' then str = tostring(str) end
      if type(str) ~= 'string' then error(sformat("bad argument #%d to 'pack' (string expected, got %s)", arg + 1, type(str)), 2) end
      arg = arg + 1
      if size == 0 then size = #str end
      if #str < size then error(sformat("bad argument #%d to 'pack' (string too short)", arg), 2) end
      out[#out + 1] = str:sub(1, size)
      if opt == 's' then
        out[#out + 1] = '\0'
        size = size + 1
      end
    else
      i = struct_control(fmt, i, opt, h, 'pack')
    end
    total = total + size
  end
  return table.concat(out)
end

struct.unpack = function(fmt, data, init)
  if type(fmt) ~= 'string' then error("bad argument #1 to 'unpack' (string expected, got " .. type(fmt) .. ')', 2) end
  if type(data) ~= 'string' then error("bad argument #2 to 'unpack' (string expected, got " .. type(data) .. ')', 2) end
  local ld = #data
  local pos = init == nil and 1 or math.tointeger(tonumber(init)) or math.floor(tonumber(init))
  if pos <= 0 then error("bad argument #3 to 'unpack' (offset must be 1 or greater)", 2) end
  pos = pos - 1
  local h = { little = true, align = 1 }
  local res = {}
  local n = 0
  local i = 1
  while i <= #fmt do
    local opt, size
    opt, size, i = struct_optsize(fmt, i)
    pos = pos + struct_toalign(pos, h, opt, size)
    if not (size <= ld and pos <= ld - size) then error("bad argument #2 to 'unpack' (data string too short)", 2) end
    if opt:match('^[bBhHlLTiI]$') then
      n = n + 1
      res[n] = struct_getint(data, pos + 1, size, h.little, opt:match('%l') ~= nil)
    elseif opt == 'x' then
      -- padding
    elseif opt == 'f' or opt == 'd' then
      n = n + 1
      res[n] = (sunpack((h.little and '<' or '>') .. opt, data, pos + 1))
    elseif opt == 'c' then
      if size == 0 then
        if n == 0 or type(res[n]) ~= 'number' then error("format 'c0' needs a previous size", 2) end
        size = math.tointeger(res[n]) or math.floor(res[n])
        res[n] = nil
        n = n - 1
        if not (size <= ld and pos <= ld - size) then error("bad argument #2 to 'unpack' (data string too short)", 2) end
      end
      n = n + 1
      res[n] = data:sub(pos + 1, pos + size)
    elseif opt == 's' then
      local e = data:find('\0', pos + 1, true)
      if e == nil then error('unfinished string in data', 2) end
      size = e - pos
      n = n + 1
      res[n] = data:sub(pos + 1, e - 1)
    else
      i = struct_control(fmt, i, opt, h, 'unpack')
    end
    pos = pos + size
  end
  n = n + 1
  res[n] = pos + 1
  return table.unpack(res, 1, n)
end

struct.size = function(fmt)
  if type(fmt) ~= 'string' then error("bad argument #1 to 'size' (string expected, got " .. type(fmt) .. ')', 2) end
  local h = { little = true, align = 1 }
  local pos = 0
  local i = 1
  while i <= #fmt do
    local opt, size
    opt, size, i = struct_optsize(fmt, i)
    pos = pos + struct_toalign(pos, h, opt, size)
    if opt == 's' then error("bad argument #1 to 'size' (options 's' and 'c0' have variable size)", 2)
    elseif opt == 'c' and size == 0 then error("bad argument #1 to 'size' (variable size in format)", 2)
    elseif not struct_sizes[opt] and opt ~= 'c' and opt ~= 'i' and opt ~= 'I' then i = struct_control(fmt, i, opt, h, 'size') end
    pos = pos + size
  end
  return pos
end

-- ---------- global protection (Redis 7: readonly globals, error on nonexistent globals) ----------
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
