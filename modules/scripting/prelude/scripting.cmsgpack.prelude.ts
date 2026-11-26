/**
 * Lua prelude, part 6 of 8: The `cmsgpack` library (lua-cmsgpack 0.4.0): pack / unpack / unpack_one / unpack_limit
 * with its encodings (numbers as Lua 5.1 doubles: integral values as integers, others as float32 when exact, tables as
 * arrays only without holes, at most 16 nested tables), its error texts and its offset / limit rules.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_CMSGPACK = String.raw`-- ---------- cmsgpack ----------
do
  local MAX_NESTING = 16

  -- ---------- pack ----------
  local function pack_number(v)
    local iv = mtointeger(v)
    if iv then
      if iv >= 0 then
        if iv <= 0x7f then return schar(iv) end
        if iv <= 0xff then return '\204' .. schar(iv) end
        if iv <= 0xffff then return '\205' .. spack('>I2', iv) end
        if iv <= 0xffffffff then return '\206' .. spack('>I4', iv) end
        return '\207' .. spack('>i8', iv)
      end
      if iv >= -32 then return schar(iv + 0x100) end
      if iv >= -128 then return '\208' .. spack('>i1', iv) end
      if iv >= -32768 then return '\209' .. spack('>i2', iv) end
      if iv >= -2147483648 then return '\210' .. spack('>i4', iv) end
      return '\211' .. spack('>i8', iv)
    end
    -- a double that survives the trip through float32 is packed as float32
    if v == v and sunpack('>f', spack('>f', v)) == v then return '\202' .. spack('>f', v) end
    return '\203' .. spack('>d', v)
  end
  local function pack_header(n, fix, fixmax, h16, h32)
    if n <= fixmax then return schar(fix + n) end
    if n <= 0xffff then return h16 .. spack('>I2', n) end
    return h32 .. spack('>I4', n)
  end
  local pack_value
  pack_value = function(v, depth, out)
    local t = __type(v)
    if t == 'boolean' then out[#out + 1] = v and '\195' or '\194'
    elseif t == 'number' then out[#out + 1] = pack_number(v)
    elseif t == 'string' then
      local n = #v
      if n < 32 then out[#out + 1] = schar(0xa0 + n)
      elseif n <= 0xff then out[#out + 1] = '\217' .. schar(n)
      elseif n <= 0xffff then out[#out + 1] = '\218' .. spack('>I2', n)
      else out[#out + 1] = '\219' .. spack('>I4', n) end
      out[#out + 1] = v
    elseif t == 'table' and depth < MAX_NESTING then
      depth = depth + 1
      -- an array: only positive integer keys and no holes
      local max, count, array = 0, 0, true
      for k in __pairs(v) do
        count = count + 1
        if mtype(k) == 'integer' and k >= 1 then
          if k > max then max = k end
        else
          array = false
        end
      end
      if array and max == count then
        out[#out + 1] = pack_header(count, 0x90, 15, '\220', '\221')
        for i = 1, count do pack_value(v[i], depth, out) end
      else
        out[#out + 1] = pack_header(count, 0x80, 15, '\222', '\223')
        for k, val in __pairs(v) do
          pack_value(k, depth, out)
          pack_value(val, depth, out)
        end
      end
    else
      out[#out + 1] = '\192'
    end
  end

  -- ---------- unpack ----------
  local function missing() lib_error('Missing bytes in input.') end
  local function bad_format() lib_error('Bad data format in input.') end
  local function need(s, i, n) if i + n - 1 > #s then missing() end end
  -- a 64-bit integer seen as a Lua 5.1 double
  local function int64(v) return normnum(v + 0.0) end
  local decode
  local function decode_array(s, i, n, depth)
    local t = {}
    for k = 1, n do t[k], i = decode(s, i, depth) end
    return t, i
  end
  local function decode_map(s, i, n, depth)
    local t = {}
    for _ = 1, n do
      local k, v
      k, i = decode(s, i, depth)
      v, i = decode(s, i, depth)
      if k == nil then __error('table index is nil', 0) end
      if k ~= k then __error('table index is NaN', 0) end
      t[k] = v
    end
    return t, i
  end
  local function decode_str(s, i, len)
    need(s, i, len)
    return ssub(s, i, i + len - 1), i + len
  end
  -- The value at i: value, next index.
  decode = function(s, i, depth)
    local b = sbyte(s, i)
    if b == nil then missing() end
    i = i + 1
    if b <= 0x7f then return b, i end
    if b >= 0xe0 then return b - 0x100, i end
    if b <= 0x8f then return decode_map(s, i, b - 0x80, depth) end
    if b <= 0x9f then return decode_array(s, i, b - 0x90, depth) end
    if b <= 0xbf then return decode_str(s, i, b - 0xa0) end
    if b == 0xc0 then return nil, i end
    if b == 0xc2 then return false, i end
    if b == 0xc3 then return true, i end
    if b == 0xc4 or b == 0xd9 then need(s, i, 1) return decode_str(s, i + 1, sbyte(s, i)) end
    if b == 0xc5 or b == 0xda then need(s, i, 2) return decode_str(s, i + 2, sunpack('>I2', s, i)) end
    if b == 0xc6 or b == 0xdb then need(s, i, 4) return decode_str(s, i + 4, sunpack('>I4', s, i)) end
    if b == 0xca then need(s, i, 4) return normnum(sunpack('>f', s, i)), i + 4 end
    if b == 0xcb then need(s, i, 8) return normnum(sunpack('>d', s, i)), i + 8 end
    if b == 0xcc then need(s, i, 1) return sbyte(s, i), i + 1 end
    if b == 0xcd then need(s, i, 2) return (sunpack('>I2', s, i)), i + 2 end
    if b == 0xce then need(s, i, 4) return (sunpack('>I4', s, i)), i + 4 end
    if b == 0xcf or b == 0xd3 then need(s, i, 8) return int64((sunpack('>i8', s, i))), i + 8 end
    if b == 0xd0 then need(s, i, 1) return (sunpack('>i1', s, i)), i + 1 end
    if b == 0xd1 then need(s, i, 2) return (sunpack('>i2', s, i)), i + 2 end
    if b == 0xd2 then need(s, i, 4) return (sunpack('>i4', s, i)), i + 4 end
    if b == 0xdc then need(s, i, 2) return decode_array(s, i + 2, sunpack('>I2', s, i), depth) end
    if b == 0xdd then need(s, i, 4) return decode_array(s, i + 4, sunpack('>I4', s, i), depth) end
    if b == 0xde then need(s, i, 2) return decode_map(s, i + 2, sunpack('>I2', s, i), depth) end
    if b == 0xdf then need(s, i, 4) return decode_map(s, i + 4, sunpack('>I4', s, i), depth) end
    bad_format()
  end
  local function check_input(fname, n, s)
    if __type(s) == 'number' then return num2str(s) end
    if __type(s) ~= 'string' then arg_error(fname, 1, 'string expected, got ' .. typename_at(n, 1, s)) end
    return s
  end
  -- luaL_checkinteger / luaL_optinteger: numbers (and numeric strings) truncated
  local function check_int(fname, n, i, v, default)
    if v == nil and default ~= nil then return default end
    return checkint(fname, n, i, v)
  end
  -- unpack_full: up to limit values (0 = all, without the offset in front) from offset.
  local function unpack_full(s, limit, offset)
    local len = #s
    if offset < 0 or limit < 0 then lib_error(sformat('Invalid request to unpack with offset of %d and limit of %d.', offset, len)) end
    if offset > len then lib_error(sformat('Start offset %d greater than input length %d.', offset, len)) end
    local out, n, i = {}, 0, offset + 1
    if limit == 0 and offset == 0 then
      while i <= len do
        n = n + 1
        out[n], i = decode(s, i, 0)
      end
      return tunpack(out, 1, n)
    end
    while n < limit and i <= len do
      n = n + 1
      out[n], i = decode(s, i, 0)
    end
    return i <= len and i - 1 or -1, tunpack(out, 1, n)
  end

  cmsgpack = {
    _NAME = 'cmsgpack',
    _VERSION = 'lua-cmsgpack 0.4.0',
    _COPYRIGHT = 'Copyright (C) 2012, Salvatore Sanfilippo',
    _DESCRIPTION = 'MessagePack C implementation for Lua',
    pack = __cwrap(function(...)
      local n = __select('#', ...)
      if n == 0 then lib_error("bad argument #0 to 'pack' (MessagePack pack needs input.)") end
      local out = {}
      for i = 1, n do pack_value((__select(i, ...)), 0, out) end
      return tconcat(out)
    end),
    unpack = __cwrap(function(...)
      return unpack_full(check_input('unpack', __select('#', ...), (...)), 0, 0)
    end),
    unpack_one = __cwrap(function(...)
      local n = __select('#', ...)
      local s, offset = ...
      s = check_input('unpack_one', n, s)
      return unpack_full(s, 1, check_int('unpack_one', n, 2, offset, 0))
    end),
    unpack_limit = __cwrap(function(...)
      local n = __select('#', ...)
      local s, limit, offset = ...
      s = check_input('unpack_limit', n, s)
      limit = check_int('unpack_limit', n, 2, limit)
      return unpack_full(s, limit, check_int('unpack_limit', n, 3, offset, 0))
    end),
  }
end

`;
