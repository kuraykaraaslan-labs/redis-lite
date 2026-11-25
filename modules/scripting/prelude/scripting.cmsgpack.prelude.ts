/**
 * Lua prelude, part 6 of 8: The `cmsgpack` library (pack / unpack / unpack_one).
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_CMSGPACK = String.raw`-- ---------- cmsgpack ----------
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

`;
