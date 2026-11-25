/**
 * Lua prelude, part 7 of 8: The `struct` library (pack / unpack / size), as bundled with Redis.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_STRUCT = String.raw`-- ---------- struct (Roberto Ierusalimschy's struct library, as bundled with Redis) ----------
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

`;
