/**
 * Lua prelude, part 7 of 8: The `struct` library (pack / unpack / size), as bundled with Redis: formats, alignment,
 * error texts and argument numbering of the C library; errors carry the caller's position.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_STRUCT = String.raw`-- ---------- struct (Roberto Ierusalimschy's struct library, as bundled with Redis) ----------
do
  local STRUCT_MAXINTSIZE = 32
  local STRUCT_MAXALIGN = 8
  -- sizeof on 64-bit Linux, where Redis runs: long and size_t are 8 bytes.
  local struct_sizes = { b = 1, B = 1, h = 2, H = 2, l = 8, L = 8, T = 8, f = 4, d = 8, x = 1 }
  local INTEGER_OPTIONS = { b = true, B = true, h = true, H = true, l = true, L = true, T = true, i = true, I = true }

  local function getnum(fmt, i, df)
    local digits = smatch(fmt, '^%d+', i)
    if not digits then return df, i end
    local a = __tonumber(digits)
    if a > 2147483647 then lib_error('integral size overflow') end
    return mtointeger(a), i + #digits
  end

  -- Returns opt, size, next index.
  local function optsize(fmt, i)
    local opt = ssub(fmt, i, i)
    i = i + 1
    local size = struct_sizes[opt]
    if size then return opt, size, i end
    if opt == 'c' then
      size, i = getnum(fmt, i, 1)
      return opt, size, i
    end
    if opt == 'i' or opt == 'I' then
      size, i = getnum(fmt, i, 4)
      if size > STRUCT_MAXINTSIZE then lib_error(sformat('integral size %d is larger than limit of %d', size, STRUCT_MAXINTSIZE)) end
      return opt, size, i
    end
    return opt, 0, i
  end

  local function toalign(len, h, opt, size)
    if size == 0 or opt == 'c' then return 0 end
    if size > h.align then size = h.align end
    return (size - (len & (size - 1))) & (size - 1)
  end

  local function control(fmt, i, opt, h, fname)
    if opt == ' ' then return i end
    if opt == '>' then h.little = false return i end
    if opt == '<' then h.little = true return i end
    if opt == '!' then
      local a
      a, i = getnum(fmt, i, STRUCT_MAXALIGN)
      if a == 0 or (a & (a - 1)) ~= 0 then lib_error(sformat('alignment %d is not a power of 2', a)) end
      h.align = a
      return i
    end
    arg_error(fname, 1, sformat("invalid format option '%s'", opt))
  end

  local function putint(n, size, little)
    local v
    if mtype(n) == 'integer' then v = n
    elseif n < 0 then v = mtointeger(mceil(n)) or (-0x7fffffffffffffff - 1)
    else v = mtointeger(mfloor(n)) or (n >= 2^63 and mtointeger(n - 2^64) or 0) end
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
    return schar(tunpack(bytes))
  end

  local function getint(data, pos, size, little, signed)
    local l = 0
    for k = 0, size - 1 do
      local idx = little and (pos + size - 1 - k) or (pos + k)
      l = (l << 8) | sbyte(data, idx)
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

  local function check_format(fname, n, fmt)
    if __type(fmt) == 'number' then return num2str(fmt) end
    if __type(fmt) ~= 'string' then arg_error(fname, 1, 'string expected, got ' .. typename_at(n, 1, fmt)) end
    return fmt
  end

  struct = {}
  struct.pack = __cwrap(function(...)
    local argc = __select('#', ...)
    local fmt = check_format('pack', argc, (...))
    local args = tpack(...)
    local h = { little = true, align = 1 }
    local arg = 1
    local out = {}
    local total = 0
    local i = 1
    while i <= #fmt do
      local opt, size
      opt, size, i = optsize(fmt, i)
      local pad = toalign(total, h, opt, size)
      total = total + pad
      if pad > 0 then out[#out + 1] = srep('\0', pad) end
      if INTEGER_OPTIONS[opt] or opt == 'f' or opt == 'd' then
        arg = arg + 1
        local v = args[arg]
        local num = (__type(v) == 'number' or __type(v) == 'string') and __tonumber(v) or nil
        if num == nil then arg_error('pack', arg, 'number expected, got ' .. __type(v)) end
        if INTEGER_OPTIONS[opt] then out[#out + 1] = putint(num, size, h.little)
        else out[#out + 1] = spack((h.little and '<' or '>') .. opt, num) end
      elseif opt == 'x' then
        out[#out + 1] = '\0'
      elseif opt == 'c' or opt == 's' then
        arg = arg + 1
        local str = args[arg]
        if __type(str) == 'number' then str = num2str(str) end
        if __type(str) ~= 'string' then arg_error('pack', arg, 'string expected, got ' .. typename_at(argc, arg, str)) end
        if size == 0 then size = #str end
        -- the C library checks with the next argument's number
        if #str < size then arg_error('pack', arg + 1, 'string too short') end
        out[#out + 1] = ssub(str, 1, size)
        if opt == 's' then
          out[#out + 1] = '\0'
          size = size + 1
        end
      else
        i = control(fmt, i, opt, h, 'pack')
      end
      total = total + size
    end
    return tconcat(out)
  end)

  struct.unpack = __cwrap(function(...)
    local argc = __select('#', ...)
    local fmt, data, init = ...
    fmt = check_format('unpack', argc, fmt)
    if __type(data) == 'number' then data = num2str(data)
    elseif __type(data) ~= 'string' then arg_error('unpack', 2, 'string expected, got ' .. typename_at(argc, 2, data)) end
    local ld = #data
    local pos = 1
    if init ~= nil then
      local x = __tonumber(init)
      if x == nil then arg_error('unpack', 3, 'number expected, got ' .. __type(init)) end
      pos = x >= 0 and mfloor(x) or mceil(x)
    end
    if pos <= 0 then arg_error('unpack', 3, 'offset must be 1 or greater') end
    pos = pos - 1
    local h = { little = true, align = 1 }
    local res = {}
    local n = 0
    local i = 1
    while i <= #fmt do
      local opt, size
      opt, size, i = optsize(fmt, i)
      pos = pos + toalign(pos, h, opt, size)
      if not (size <= ld and pos <= ld - size) then arg_error('unpack', 2, 'data string too short') end
      if INTEGER_OPTIONS[opt] then
        n = n + 1
        res[n] = getint(data, pos + 1, size, h.little, smatch(opt, '%l') ~= nil)
      elseif opt == 'x' then
        -- padding
      elseif opt == 'f' or opt == 'd' then
        n = n + 1
        res[n] = normnum(sunpack((h.little and '<' or '>') .. opt, data, pos + 1))
      elseif opt == 'c' then
        if size == 0 then
          if n == 0 or __type(res[n]) ~= 'number' then lib_error("format 'c0' needs a previous size") end
          size = mtointeger(res[n]) or mfloor(res[n])
          res[n] = nil
          n = n - 1
          if not (size <= ld and pos <= ld - size) then arg_error('unpack', 2, 'data string too short') end
        end
        n = n + 1
        res[n] = ssub(data, pos + 1, pos + size)
      elseif opt == 's' then
        local e = sfind(data, '\0', pos + 1, true)
        if e == nil then lib_error('unfinished string in data') end
        size = e - pos
        n = n + 1
        res[n] = ssub(data, pos + 1, e - 1)
      else
        i = control(fmt, i, opt, h, 'unpack')
      end
      pos = pos + size
    end
    n = n + 1
    res[n] = pos + 1
    return tunpack(res, 1, n)
  end)

  struct.size = __cwrap(function(...)
    local fmt = check_format('size', __select('#', ...), (...))
    local h = { little = true, align = 1 }
    local pos = 0
    local i = 1
    while i <= #fmt do
      local opt, size
      local start = i
      opt, size, i = optsize(fmt, i)
      pos = pos + toalign(pos, h, opt, size)
      if opt == 's' or (opt == 'c' and size == 0) then
        arg_error('size', 1, sformat("option '%s' has no fixed size", ssub(fmt, start, i - 1)))
      elseif not struct_sizes[opt] and opt ~= 'c' and opt ~= 'i' and opt ~= 'I' then
        i = control(fmt, i, opt, h, 'size')
      end
      pos = pos + size
    end
    return pos
  end)
end

`;
