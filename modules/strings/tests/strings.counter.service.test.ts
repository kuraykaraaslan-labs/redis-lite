import { describe, expect, it } from 'vitest';

import { arity, err, NOT_FLOAT, NOT_INT, resp3Client, useServer, WRONGTYPE } from '@/tests/helpers';
import type { RawClient } from '@/tests/helpers';

/**
 * INCR, DECR, INCRBY, DECRBY, INCRBYFLOAT (strings.counter.service).
 * Expected values come from the redis.io command documentation and Redis source error strings.
 */
const t = useServer();
const resp3 = (): Promise<RawClient> => resp3Client(t);

// ============================================================================
// INCR family
// ============================================================================

describe('INCR / DECR / INCRBY / DECRBY', () => {
  it('docs examples', async () => {
    await t.call('SET', 'in:a', '10');
    expect(await t.call('INCR', 'in:a')).toBe(11);
    expect(await t.call('GET', 'in:a')).toBe('11');
    expect(await t.call('DECR', 'in:a')).toBe(10);
    expect(await t.call('INCRBY', 'in:a', 5)).toBe(15);
    expect(await t.call('DECRBY', 'in:a', 3)).toBe(12);
    expect(await t.call('INCRBY', 'in:a', -20)).toBe(-8);
    expect(await t.call('DECRBY', 'in:a', -8)).toBe(0);
    expect(await t.call('INCR', 'in:new')).toBe(1);
    expect(await t.call('DECR', 'in:new2')).toBe(-1);
    expect(await t.call('INCRBY', 'in:new3', 7)).toBe(7);
    expect(await t.call('DECRBY', 'in:new4', 7)).toBe(-7);
  });

  it('keeps the TTL', async () => {
    await t.call('SET', 'in:ttl', '1', 'EX', 100);
    await t.call('INCR', 'in:ttl');
    expect(await t.call('TTL', 'in:ttl')).toBeGreaterThan(95);
  });

  it('non-integer values and increments', async () => {
    await t.call('SET', 'in:s', 'abc');
    expect(await err(t.call('INCR', 'in:s'))).toBe(NOT_INT);
    await t.call('SET', 'in:sp', ' 1');
    expect(await err(t.call('INCR', 'in:sp'))).toBe(NOT_INT);
    await t.call('SET', 'in:f', '1.5');
    expect(await err(t.call('INCR', 'in:f'))).toBe(NOT_INT);
    await t.call('SET', 'in:big', '92233720368547758070');
    expect(await err(t.call('INCR', 'in:big'))).toBe(NOT_INT);
    expect(await err(t.call('INCRBY', 'in:x', 'abc'))).toBe(NOT_INT);
    expect(await err(t.call('INCRBY', 'in:x', '1.5'))).toBe(NOT_INT);
    expect(await err(t.call('DECRBY', 'in:x', 'abc'))).toBe(NOT_INT);
    expect(await t.call('EXISTS', 'in:x')).toBe(0);
  });

  it('overflow', async () => {
    await t.call('SET', 'in:max', '9223372036854775807');
    expect(await err(t.call('INCR', 'in:max'))).toBe('ERR increment or decrement would overflow');
    expect(await t.call('GET', 'in:max')).toBe('9223372036854775807');
    await t.call('SET', 'in:min', '-9223372036854775808');
    expect(await err(t.call('DECR', 'in:min'))).toBe('ERR increment or decrement would overflow');
    expect(await err(t.call('INCRBY', 'in:min', -1))).toBe('ERR increment or decrement would overflow');
    await t.call('SET', 'in:one', '1');
    expect(await err(t.call('INCRBY', 'in:one', '9223372036854775807'))).toBe('ERR increment or decrement would overflow');
    expect(await err(t.call('DECRBY', 'in:one', '-9223372036854775808'))).toBe('ERR decrement would overflow');
    expect(await err(t.call('INCRBY', 'in:one', '9223372036854775808'))).toBe(NOT_INT);
  });

  it('exact 64-bit replies on the wire', async () => {
    const r = await t.raw();
    await r.send('SET', 'in:w', '9223372036854775806');
    expect(await r.send('INCR', 'in:w')).toBe(':9223372036854775807\r\n');
    await r.send('SET', 'in:w2', '-9223372036854775807');
    expect(await r.send('DECR', 'in:w2')).toBe(':-9223372036854775808\r\n');
  });

  it('wrong type and arity', async () => {
    await t.call('RPUSH', 'in:l', 'x');
    expect(await err(t.call('INCR', 'in:l'))).toBe(WRONGTYPE);
    expect(await err(t.call('DECRBY', 'in:l', 1))).toBe(WRONGTYPE);
    expect(await err(t.call('INCR'))).toBe(arity('incr'));
    expect(await err(t.call('DECR'))).toBe(arity('decr'));
    expect(await err(t.call('INCRBY', 'a'))).toBe(arity('incrby'));
    expect(await err(t.call('DECRBY', 'a'))).toBe(arity('decrby'));
  });
});

describe('INCRBYFLOAT', () => {
  it('docs examples', async () => {
    await t.call('SET', 'if:a', '10.50');
    expect(await t.call('INCRBYFLOAT', 'if:a', '0.1')).toBe('10.6');
    expect(await t.call('INCRBYFLOAT', 'if:a', '-5')).toBe('5.6');
    await t.call('SET', 'if:a', '5.0e3');
    expect(await t.call('INCRBYFLOAT', 'if:a', '2.0e2')).toBe('5200');
    expect(await t.call('GET', 'if:a')).toBe('5200');
  });

  it('formatting: integers without decimals, no trailing zeros', async () => {
    expect(await t.call('INCRBYFLOAT', 'if:new', '3.0')).toBe('3');
    expect(await t.call('INCRBYFLOAT', 'if:new', '1.5')).toBe('4.5');
    expect(await t.call('INCRBYFLOAT', 'if:new', '-4.5')).toBe('0');
    await t.call('SET', 'if:i', '10');
    expect(await t.call('INCRBYFLOAT', 'if:i', '0.25')).toBe('10.25');
  });

  it('keeps the TTL', async () => {
    await t.call('SET', 'if:ttl', '1', 'EX', 100);
    await t.call('INCRBYFLOAT', 'if:ttl', '1.1');
    expect(await t.call('TTL', 'if:ttl')).toBeGreaterThan(95);
  });

  it('errors', async () => {
    await t.call('SET', 'if:s', 'abc');
    expect(await err(t.call('INCRBYFLOAT', 'if:s', '1'))).toBe(NOT_FLOAT);
    expect(await err(t.call('INCRBYFLOAT', 'if:x', 'abc'))).toBe(NOT_FLOAT);
    // long double range: 2e308 is finite, only sums past ~1.19e4932 overflow
    await t.call('SET', 'if:huge', '1.1e4932');
    expect(await err(t.call('INCRBYFLOAT', 'if:huge', '1.1e4932'))).toBe('ERR increment would produce NaN or Infinity');
    expect(await t.call('GET', 'if:huge')).toBe('1.1e4932');
    expect(await err(t.call('INCRBYFLOAT', 'if:x', 'inf'))).toBe('ERR increment would produce NaN or Infinity');
    expect(await err(t.call('INCRBYFLOAT', 'if:x', 'nan'))).toMatch(/^ERR /);
    expect(await t.call('EXISTS', 'if:x')).toBe(0);
    await t.call('RPUSH', 'if:l', 'x');
    expect(await err(t.call('INCRBYFLOAT', 'if:l', '1'))).toBe(WRONGTYPE);
    expect(await err(t.call('INCRBYFLOAT', 'if:l'))).toBe(arity('incrbyfloat'));
  });

  it('is a bulk string in RESP3 too', async () => {
    const r = await resp3();
    await r.send('SET', 'if:r3', '10.5');
    expect(await r.send('INCRBYFLOAT', 'if:r3', '0.1')).toBe('$4\r\n10.6\r\n');
  });
});
