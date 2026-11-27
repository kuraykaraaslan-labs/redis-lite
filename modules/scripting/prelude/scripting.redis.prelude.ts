import { REDIS_VERSION } from '@/modules/server/server.constants';

/**
 * Lua prelude, part 2 of 8: The `redis` table. `redis.call`, `redis.pcall` and `redis.acl_check_cmd` are host functions
 * registered by the engine (they raise their errors themselves); the rest is Lua: error_reply / status_reply,
 * sha1hex, setresp, log, set_repl and the compatibility helpers, with Redis's argument checks and texts (their errors are
 * {err = 'ERR …'} tables, as Redis 7.0 raises them: pcall hands out the text).
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
const VERSION_NUM = REDIS_VERSION.split('.').reduce((n, part) => n * 256 + Number(part), 0);

export const LUA_REDIS = String.raw`-- ---------- redis ----------
local function reply_args_error() return { err = 'ERR wrong number or type of arguments' } end
local __sha1hex, __setresp = __redis_sha1hex, __redis_setresp
redis = {
  call = __redis_call,
  pcall = __redis_pcall,
  acl_check_cmd = __redis_acl_check_cmd,
}
__redis_call, __redis_pcall, __redis_acl_check_cmd, __redis_sha1hex, __redis_setresp = nil, nil, nil, nil, nil

-- Wrong arguments give an error reply (returned, not raised). The error code is the first word: a message without a
-- space has none and gets "ERR "; a leading "-" is dropped.
redis.error_reply = function(...)
  local msg = ...
  if __select('#', ...) ~= 1 or __type(msg) ~= 'string' then return reply_args_error() end
  if sbyte(msg, 1) == 45 then msg = ssub(msg, 2) end
  if not sfind(msg, ' ', 1, true) then msg = 'ERR ' .. msg end
  return { err = msg }
end
redis.status_reply = function(...)
  local msg = ...
  if __select('#', ...) ~= 1 or __type(msg) ~= 'string' then return reply_args_error() end
  return { ok = msg }
end
redis.sha1hex = function(...)
  if __select('#', ...) ~= 1 then __error({ err = 'ERR wrong number of arguments' }) end
  local v = ...
  if __type(v) == 'number' then v = num2str(v) elseif __type(v) ~= 'string' then v = '' end
  return __sha1hex(v)
end
redis.LOG_DEBUG, redis.LOG_VERBOSE, redis.LOG_NOTICE, redis.LOG_WARNING = 0, 1, 2, 3
-- The level is converted like lua_tonumber + (int): '3' and 3.5 are level 3.
local function int_of(v)
  local n = __tonumber(v)
  if n == nil then return nil end
  return n >= 0 and mfloor(n) or mceil(n)
end
redis.log = function(...)
  if __select('#', ...) < 2 then __error({ err = 'ERR redis.log() requires two arguments or more.' }) end
  local level = int_of((...))
  if level == nil then __error({ err = 'ERR First argument must be a number (log level).' }) end
  if level < 0 or level > 3 then __error({ err = 'ERR Invalid debug level.' }) end
end
redis.setresp = function(...)
  if __select('#', ...) ~= 1 then __error({ err = 'ERR redis.setresp() requires one argument.' }) end
  local v = __tonumber((...))
  if v ~= 2 and v ~= 3 then __error({ err = 'ERR RESP version must be 2 or 3.' }) end
  __setresp(v)
end
redis.REPL_NONE, redis.REPL_AOF, redis.REPL_SLAVE, redis.REPL_REPLICA, redis.REPL_ALL = 0, 1, 2, 2, 3
redis.set_repl = function(...)
  if __select('#', ...) ~= 1 then __error({ err = 'ERR redis.set_repl() requires two arguments.' }) end
  local flags = int_of((...)) or 0
  if flags < 0 or flags > 3 then __error({ err = 'ERR Invalid replication flags. Use REPL_AOF, REPL_REPLICA, REPL_ALL or REPL_NONE.' }) end
end
redis.replicate_commands = function() return true end
redis.breakpoint = function() return false end
redis.debug = function() end
redis.REDIS_VERSION = '${REDIS_VERSION}'
redis.REDIS_VERSION_NUM = ${VERSION_NUM}

`;
