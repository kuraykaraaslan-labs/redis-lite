/**
 * Lua prelude, part 5 of 8: The `cjson` library (lua-cjson 2.1.0 as configured in Redis): numbers with "%.14g",
 * sparse arrays (an integer-keyed table is an array unless its largest index is above 10 and more than twice its count),
 * a nesting limit of 1000 both ways, a decoder that follows the lua-cjson tokenizer (its token names and error texts,
 * hexadecimal / inf / nan numbers accepted) and `cjson.null` as a userdata. Errors carry the caller's position.
 *
 * Lua source text, concatenated in order by `../scripting.prelude.ts` and run as ONE chunk: locals defined by an
 * earlier part are visible to the later ones.
 */
export const LUA_CJSON = String.raw`-- ---------- cjson ----------
-- a lightuserdata NULL in lua-cjson: a userdata that prints as one
local cjson_null = __newproxy(true)
__getmetatable(cjson_null).__tostring = function() return 'userdata: (nil)' end
do
  local uchar = utf8.char
  local MAX_DEPTH = 1000
  local SPARSE_RATIO, SPARSE_SAFE = 2, 10

  -- ---------- encode ----------
  local escapes = { ['/'] = '\\/', ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
  local function escape_char(c) return escapes[c] or sformat('\\u%04x', sbyte(c)) end
  local function encode_string(s)
    if not sfind(s, '[%c"\\/]') then return '"' .. s .. '"' end
    return '"' .. sgsub(s, '[%c"\\/]', escape_char) .. '"'
  end
  local function encode_number(v)
    if v ~= v or v == mhuge or v == -mhuge then lib_error('Cannot serialise number: must not be NaN or Inf') end
    return sformat('%.14g', v)
  end
  -- The array length of t (lua-cjson lua_array_length): -1 when t is an object.
  local function array_length(t)
    local max, count = 0, 0
    for k in __pairs(t) do
      if mtype(k) ~= 'integer' or k < 1 then return -1 end
      if k > max then max = k end
      count = count + 1
    end
    if max > SPARSE_SAFE and max > count * SPARSE_RATIO then lib_error('Cannot serialise table: excessively sparse array') end
    return max
  end
  local encode_value
  encode_value = function(v, depth, out)
    local t = __type(v)
    if v == nil or v == cjson_null then out[#out + 1] = 'null'
    elseif t == 'boolean' then out[#out + 1] = v and 'true' or 'false'
    elseif t == 'number' then out[#out + 1] = encode_number(v)
    elseif t == 'string' then out[#out + 1] = encode_string(v)
    elseif t == 'table' then
      depth = depth + 1
      if depth > MAX_DEPTH then lib_error(sformat('Cannot serialise, excessive nesting (%d)', depth)) end
      local len = array_length(v)
      if len > 0 then
        out[#out + 1] = '['
        for i = 1, len do
          if i > 1 then out[#out + 1] = ',' end
          encode_value(v[i], depth, out)
        end
        out[#out + 1] = ']'
      else
        out[#out + 1] = '{'
        local first = true
        for k, val in __pairs(v) do
          local kt = __type(k)
          if kt ~= 'string' and kt ~= 'number' then lib_error('Cannot serialise ' .. kt .. ': table key must be a number or string') end
          if not first then out[#out + 1] = ',' end
          first = false
          out[#out + 1] = encode_string(kt == 'number' and encode_number(k) or k)
          out[#out + 1] = ':'
          encode_value(val, depth, out)
        end
        out[#out + 1] = '}'
      end
    else
      lib_error('Cannot serialise ' .. t .. ': type not supported')
    end
  end

  -- ---------- decode (the lua-cjson tokenizer) ----------
  -- A number as strtod reads it at i (sign, hex, inf / infinity / nan, decimal with optional fraction and exponent).
  -- Returns the value and the index after it, or nil when nothing converts.
  local function strtod(s, i)
    local j = i
    local neg = false
    local c = sbyte(s, j)
    if c == 43 or c == 45 then neg = c == 45 j = j + 1 end
    local v, e
    local hex = smatch(s, '^0[xX]%x+', j)
    if hex then
      v, e = __tonumber(hex) + 0.0, j + #hex
    else
      local word = slower(ssub(s, j, j + 7))
      if word == 'infinity' then v, e = mhuge, j + 8
      elseif ssub(word, 1, 3) == 'inf' then v, e = mhuge, j + 3
      elseif ssub(word, 1, 3) == 'nan' then v, e = -(0 / 0), j + 3 -- strtod's nan is positive (0/0 is not)
      else
        local digits = smatch(s, '^%d*%.?%d*', j)
        if digits == '' or digits == '.' then return nil end
        local exp = smatch(s, '^[eE][-+]?%d+', j + #digits)
        local text = digits .. (exp or '')
        v, e = __tonumber(text) + 0.0, j + #text
      end
    end
    if neg then v = -v end
    return v, e
  end
  -- json_is_invalid_number: what decode_invalid_numbers lets through besides '-' and digits.
  local function invalid_number_start(s, i)
    local c = sbyte(s, i)
    if c == 43 then return true end
    local w = slower(ssub(s, i, i + 2))
    return smatch(w, '^0x') ~= nil or w == 'inf' or w == 'nan'
  end
  local function utf16_at(s, j)
    local h = smatch(s, '^\\u(%x%x%x%x)', j)
    return h and __tonumber(h, 16)
  end
  -- The string token starting at the quote at i: value, next index; or nil, error text, error position.
  local function read_string(s, i)
    local parts = {}
    local j = i + 1
    while true do
      local p = sfind(s, '["\\]', j)
      if p == nil then return nil, 'unexpected end of string', #s + 1 end
      if p > j then parts[#parts + 1] = ssub(s, j, p - 1) end
      if sbyte(s, p) == 34 then return tconcat(parts), p + 1 end
      local esc = ssub(s, p + 1, p + 1)
      local simple = ({ ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' })[esc]
      if simple then
        parts[#parts + 1] = simple
        j = p + 2
      elseif esc == 'u' then
        local cp = utf16_at(s, p)
        if cp == nil then return nil, 'invalid unicode escape code', p end
        local nexti = p + 6
        if cp >= 0xD800 and cp <= 0xDBFF then
          local lo = utf16_at(s, nexti)
          if lo == nil or lo < 0xDC00 or lo > 0xDFFF then return nil, 'invalid unicode escape code', p end
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
          nexti = nexti + 6
        elseif cp >= 0xDC00 and cp <= 0xDFFF then
          return nil, 'invalid unicode escape code', p
        end
        parts[#parts + 1] = uchar(cp)
        j = nexti
      elseif esc == '' then
        return nil, 'unexpected end of string', #s + 1
      else
        return nil, 'invalid escape code', p
      end
    end
  end
  local SINGLE = { [123] = 'T_OBJ_BEGIN', [125] = 'T_OBJ_END', [91] = 'T_ARR_BEGIN', [93] = 'T_ARR_END', [58] = 'T_COLON', [44] = 'T_COMMA' }
  -- The next token at i: type, value, position, next index. A T_ERROR's value is its message.
  local function next_token(s, i)
    local _, ws = sfind(s, '^[ \t\n\r]*', i)
    i = ws + 1
    local c = sbyte(s, i)
    if c == nil then return 'T_END', nil, i, i end
    local single = SINGLE[c]
    if single then return single, nil, i, i + 1 end
    if c == 34 then
      local v, e, pos = read_string(s, i)
      if v == nil then return 'T_ERROR', e, pos, pos end
      return 'T_STRING', v, i, e
    end
    if c == 45 or (c >= 48 and c <= 57) or invalid_number_start(s, i) then
      local v, e = strtod(s, i)
      if v == nil then return 'T_ERROR', 'invalid number', i, i end
      return 'T_NUMBER', normnum(v), i, e
    end
    if ssub(s, i, i + 3) == 'true' then return 'T_BOOLEAN', true, i, i + 4 end
    if ssub(s, i, i + 4) == 'false' then return 'T_BOOLEAN', false, i, i + 5 end
    if ssub(s, i, i + 3) == 'null' then return 'T_NULL', cjson_null, i, i + 4 end
    return 'T_ERROR', 'invalid token', i, i
  end
  local function decode_error(what, tt, tv, pos)
    lib_error(sformat('Expected %s but found %s at character %d', what, tt == 'T_ERROR' and tv or tt, pos))
  end
  local decode_value
  -- The value whose first token was just read; returns the value and the next index.
  decode_value = function(s, tt, tv, pos, i, depth)
    if tt == 'T_STRING' or tt == 'T_NUMBER' or tt == 'T_BOOLEAN' or tt == 'T_NULL' then return tv, i end
    if tt ~= 'T_OBJ_BEGIN' and tt ~= 'T_ARR_BEGIN' then decode_error('value', tt, tv, pos) end
    depth = depth + 1
    if depth > MAX_DEPTH then lib_error(sformat('Found too many nested data structures (%d) at character %d', depth, pos)) end
    local t = {}
    if tt == 'T_ARR_BEGIN' then
      local n = 0
      tt, tv, pos, i = next_token(s, i)
      if tt == 'T_ARR_END' then return t, i end
      while true do
        local v
        v, i = decode_value(s, tt, tv, pos, i, depth)
        n = n + 1
        t[n] = v
        tt, tv, pos, i = next_token(s, i)
        if tt == 'T_ARR_END' then return t, i end
        if tt ~= 'T_COMMA' then decode_error('comma or array end', tt, tv, pos) end
        tt, tv, pos, i = next_token(s, i)
      end
    end
    tt, tv, pos, i = next_token(s, i)
    if tt == 'T_OBJ_END' then return t, i end
    while true do
      if tt ~= 'T_STRING' then decode_error('object key string', tt, tv, pos) end
      local key = tv
      tt, tv, pos, i = next_token(s, i)
      if tt ~= 'T_COLON' then decode_error('colon', tt, tv, pos) end
      tt, tv, pos, i = next_token(s, i)
      t[key], i = decode_value(s, tt, tv, pos, i, depth)
      tt, tv, pos, i = next_token(s, i)
      if tt == 'T_OBJ_END' then return t, i end
      if tt ~= 'T_COMMA' then decode_error('comma or object end', tt, tv, pos) end
      tt, tv, pos, i = next_token(s, i)
    end
  end

  cjson = {
    _NAME = 'cjson',
    _VERSION = '2.1.0',
    null = cjson_null,
    encode = __cwrap(function(...)
      if __select('#', ...) ~= 1 then lib_error("bad argument #1 to 'encode' (expected 1 argument)") end
      local out = {}
      encode_value((...), 0, out)
      return tconcat(out)
    end),
    decode = __cwrap(function(...)
      local n = __select('#', ...)
      if n ~= 1 then lib_error("bad argument #1 to 'decode' (expected 1 argument)") end
      local s = ...
      if __type(s) == 'number' then s = num2str(s)
      elseif __type(s) ~= 'string' then arg_error('decode', 1, 'string expected, got ' .. __type(s)) end
      local tt, tv, pos, i = next_token(s, 1)
      local v
      v, i = decode_value(s, tt, tv, pos, i, 0)
      tt, tv, pos = next_token(s, i)
      if tt ~= 'T_END' then decode_error('the end', tt, tv, pos) end
      return v
    end),
    -- configuration getters (Redis's defaults; the settings are not changeable)
    encode_number_precision = function() return 14 end,
    encode_sparse_array = function() return false, SPARSE_RATIO, SPARSE_SAFE end,
    encode_max_depth = function() return MAX_DEPTH end,
    decode_max_depth = function() return MAX_DEPTH end,
    encode_invalid_numbers = function() return false end,
    decode_invalid_numbers = function() return true end,
    encode_keep_buffer = function() return true end,
  }
  cjson.new = function()
    local copy = {}
    for k, v in __pairs(cjson) do copy[k] = v end
    return copy
  end
end

`;
