/**
 * Lua prelude, part 2 of 8: The `redis` table: call / pcall over the engine's `__redis_call`, error_reply / status_reply, sha1hex, setresp, acl_check_cmd and the no-op compatibility helpers (log, set_repl, breakpoint…).
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_REDIS = String.raw`-- ---------- redis ----------
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
local __acl_check = __redis_acl_check_cmd
redis.acl_check_cmd = function(...)
  local ok, r = __acl_check(...)
  if ok then return r end
  error(r, 0)
end
redis.REDIS_VERSION = '8.8.4'

`;
