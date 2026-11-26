/**
 * Lua prelude, part 4 of 8: The `bit` library (LuaBitOp): 32-bit signed results, arguments converted like
 * luaL_checknumber (numeric strings accepted) and then to 32 bits with LuaBitOp's 2^52 + 2^51 rounding trick (2.5 → 2,
 * 3.5 → 4, huge numbers keep the low mantissa bits), argument errors with LuaBitOp's texts.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_BIT = String.raw`-- ---------- bit (LuaBitOp, 32-bit) ----------
do
  local function int32(x)
    x = x & 0xffffffff
    if x >= 0x80000000 then x = x - 0x100000000 end
    return x
  end
  -- The argument #i (of n) as a signed 32-bit integer.
  local function checkbit(fname, n, i, v)
    local x = v
    if __type(x) ~= 'number' then
      x = __type(x) == 'string' and __tonumber(x) or nil
      if x == nil then arg_error(fname, i, 'number expected, got ' .. typename_at(n, i, v)) end
    end
    if mtype(x) == 'integer' and x >= -0x80000000 and x < 0x80000000 then return x end
    return (sunpack('<i4', spack('<d', x + 6755399441055744.0)))
  end
  local function fold(fname, combine)
    return function(...)
      local n = __select('#', ...)
      local r = checkbit(fname, n, 1, (...))
      for i = 2, n do r = combine(r, checkbit(fname, n, i, (__select(i, ...)))) end
      return int32(r)
    end
  end
  local function shift(fname, op)
    return function(...)
      local n = __select('#', ...)
      local a, s = ...
      return int32(op(checkbit(fname, n, 1, a), checkbit(fname, n, 2, s) & 31))
    end
  end
  bit = {
    tobit = function(...) return checkbit('tobit', __select('#', ...), 1, (...)) end,
    bnot = function(...) return int32(~checkbit('bnot', __select('#', ...), 1, (...))) end,
    band = fold('band', function(a, b) return a & b end),
    bor = fold('bor', function(a, b) return a | b end),
    bxor = fold('bxor', function(a, b) return a ~ b end),
    lshift = shift('lshift', function(a, s) return (a & 0xffffffff) << s end),
    rshift = shift('rshift', function(a, s) return (a & 0xffffffff) >> s end),
    -- a is sign-extended to 64 bits: the logical 64-bit shift brings in its sign bits
    arshift = shift('arshift', function(a, s) return a >> s end),
    rol = shift('rol', function(a, s) a = a & 0xffffffff return (a << s) | (a >> (32 - s)) end),
    ror = shift('ror', function(a, s) a = a & 0xffffffff return (a >> s) | (a << (32 - s)) end),
    bswap = function(...)
      local a = checkbit('bswap', __select('#', ...), 1, (...)) & 0xffffffff
      return int32(((a & 0xff) << 24) | ((a & 0xff00) << 8) | ((a >> 8) & 0xff00) | (a >> 24))
    end,
    tohex = function(...)
      local argc = __select('#', ...)
      local a, n = ...
      a = checkbit('tohex', argc, 1, a) & 0xffffffff
      n = argc >= 2 and n ~= nil and checkbit('tohex', argc, 2, n) or 8
      local conv = 'x'
      if n < 0 then n, conv = -n, 'X' end
      if n > 8 then n = 8 end
      if n == 0 then return '' end
      return sformat('%0' .. n .. conv, a & ((1 << (4 * n)) - 1))
    end,
  }
end

`;
