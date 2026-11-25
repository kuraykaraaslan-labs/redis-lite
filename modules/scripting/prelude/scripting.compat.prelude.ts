/**
 * Lua prelude, part 1 of 8: Sandbox and Lua 5.1 compatibility: removes os/io/package/require/dofile, restores the 5.1 aliases (unpack, loadstring, table.getn…) and prints numbers with "%.14g". Defines the locals the later parts share (`sformat`, `num2str`, `__debug`).
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_COMPAT = String.raw`
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

`;
