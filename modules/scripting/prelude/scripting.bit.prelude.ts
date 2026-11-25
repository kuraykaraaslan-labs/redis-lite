/**
 * Lua prelude, part 4 of 8: The `bit` library (LuaBitOp, 32-bit signed results).
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_BIT = String.raw`-- ---------- bit (LuaBitOp, 32-bit) ----------
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

`;
