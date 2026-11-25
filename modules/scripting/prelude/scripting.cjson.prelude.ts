/**
 * Lua prelude, part 5 of 8: The `cjson` library (encode / decode). Also defines the locals `normnum` and `is_array` that cmsgpack reuses.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_CJSON = String.raw`-- Floats with an integral value become integers, so tostring() and .. print them the way Lua 5.1 does ("5", not "5.0").
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

`;
