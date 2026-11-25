import { describe, expect, it } from 'vitest';

import DatabaseService from '@/modules/database/database.service';

import { ListDeque } from '../lists.deque.structure';

/**
 * Unit tests of the list value structure (no server): every Array-compatible method must behave like the Array method
 * of the same name, across wrap-around, growth and shrinking.
 */

/** Deterministic PRNG (mulberry32), so a failing sequence can be replayed. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ListDeque basics', () => {
  it('push / unshift / pop / shift at both ends', () => {
    const d = new ListDeque();
    expect(d.length).toBe(0);
    expect(d.pop()).toBeUndefined();
    expect(d.shift()).toBeUndefined();
    expect(d.push('b', 'c')).toBe(2);
    expect(d.unshift('a')).toBe(3);
    expect(d.unshift('y', 'z')).toBe(5);
    expect([...d]).toEqual(['y', 'z', 'a', 'b', 'c']);
    expect(d.shift()).toBe('y');
    expect(d.pop()).toBe('c');
    expect(d.toArray()).toEqual(['z', 'a', 'b']);
  });

  it('at() with negative and out-of-range indexes', () => {
    const d = ListDeque.from(['a', 'b', 'c']);
    expect(d.at(0)).toBe('a');
    expect(d.at(-1)).toBe('c');
    expect(d.at(-3)).toBe('a');
    expect(d.at(-4)).toBeUndefined();
    expect(d.at(3)).toBeUndefined();
  });

  it('set() overwrites in place and rejects out-of-range indexes', () => {
    const d = ListDeque.from(['a', 'b']);
    d.set(1, 'x');
    expect(d.toArray()).toEqual(['a', 'x']);
    expect(() => d.set(2, 'y')).toThrow(RangeError);
    expect(() => d.set(-1, 'y')).toThrow(RangeError);
  });

  it('slice() and indexOf() follow the Array index rules', () => {
    const items = ['a', 'b', 'c', 'b', 'e'];
    const d = ListDeque.from(items);
    for (const [s, e] of [[0, 5], [1, 3], [-2, 5], [-10, 2], [3, 1], [2, 99], [0, -1]] as const) {
      expect(d.slice(s, e)).toEqual(items.slice(s, e));
    }
    expect(d.slice()).toEqual(items);
    expect(d.slice(2)).toEqual(items.slice(2));
    expect(d.indexOf('b')).toBe(1);
    expect(d.indexOf('b', 2)).toBe(3);
    expect(d.indexOf('b', -2)).toBe(3);
    expect(d.indexOf('zz')).toBe(-1);
  });

  it('a large deque grows and shrinks back after draining', () => {
    const d = new ListDeque();
    for (let i = 0; i < 100_000; i++) d.unshift(String(i));
    expect(d.length).toBe(100_000);
    expect(d.at(0)).toBe('99999');
    expect(d.at(-1)).toBe('0');
    for (let i = 0; i < 99_990; i++) d.pop();
    expect(d.toArray()).toEqual(['99999', '99998', '99997', '99996', '99995', '99994', '99993', '99992', '99991', '99990']);
  });

  it('from() copies arrays and other iterables', () => {
    const source = ['a', 'b'];
    const d = ListDeque.from(source);
    source.push('c');
    expect(d.toArray()).toEqual(['a', 'b']);
    expect(ListDeque.from(new Set(['x', 'y'])).toArray()).toEqual(['x', 'y']);
    expect(ListDeque.from([]).length).toBe(0);
  });
});

describe('ListDeque.listpackBytes', () => {
  it('tracks the listpack size of the elements through every kind of change', () => {
    const d = ListDeque.from(['12', 'abc']);
    const check = (): void => expect(d.listpackBytes).toBe(DatabaseService.listpackSize(d.toArray()));
    check();
    d.push('x'.repeat(100), '-5000');
    check();
    d.unshift('9223372036854775807');
    check();
    d.set(1, 'y'.repeat(70));
    check();
    d.splice(1, 2, 'a', 'b', 'c');
    check();
    d.pop();
    d.shift();
    check();
    d.splice(0);
    expect(d.listpackBytes).toBe(7);
  });
});

describe('ListDeque.splice', () => {
  it('matches Array#splice for removals, insertions and replacements', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f'];
    const cases: Array<[number, number | undefined, string[]]> = [
      [0, 2, []], [4, 2, []], [2, 1, []], [1, 3, []], [0, undefined, []], [3, undefined, []], [-2, 1, []],
      [0, 0, ['x']], [6, 0, ['x', 'y']], [2, 0, ['x', 'y', 'z']], [5, 0, ['x']], [1, 1, ['x']], [1, 2, ['x']],
      [1, 1, ['x', 'y', 'z']], [10, 3, ['x']], [-10, 1, []], [2, -1, ['x']],
    ];
    for (const [start, del, items] of cases) {
      const array = [...base];
      const d = ListDeque.from(base);
      const expected = del === undefined ? array.splice(start) : array.splice(start, del, ...items);
      const got = del === undefined ? d.splice(start) : d.splice(start, del, ...items);
      expect(got, `splice(${start}, ${del}, ${items.join()})`).toEqual(expected);
      expect(d.toArray(), `splice(${start}, ${del}, ${items.join()})`).toEqual(array);
    }
  });
});

describe('ListDeque against Array (randomized)', () => {
  it('stays identical through a long random sequence of operations', () => {
    for (const seed of [1, 7, 42]) {
      const rand = rng(seed);
      const d = new ListDeque();
      const a: string[] = [];
      for (let step = 0; step < 20_000; step++) {
        const op = Math.floor(rand() * 9);
        const v = `v${step}`;
        const idx = Math.floor(rand() * (a.length + 2)) - 1;
        if (op === 0) expect(d.push(v, `${v}b`)).toBe(a.push(v, `${v}b`));
        else if (op === 1) expect(d.unshift(v)).toBe(a.unshift(v));
        else if (op === 2) expect(d.pop()).toBe(a.pop());
        else if (op === 3) expect(d.shift()).toBe(a.shift());
        else if (op === 4) expect(d.at(idx)).toBe(a.at(idx));
        else if (op === 5) {
          const del = Math.floor(rand() * 3);
          const items = rand() < 0.5 ? [v] : rand() < 0.5 ? [] : [v, `${v}c`, `${v}d`];
          expect(d.splice(idx, del, ...items)).toEqual(a.splice(idx, del, ...items));
        } else if (op === 6 && a.length) {
          const i = Math.floor(rand() * a.length);
          d.set(i, v);
          a[i] = v;
        } else if (op === 7) expect(d.slice(idx, idx + 5)).toEqual(a.slice(idx, idx + 5));
        else if (op === 8) expect(d.indexOf(a[Math.max(0, idx)] ?? 'none')).toBe(a.indexOf(a[Math.max(0, idx)] ?? 'none'));
        expect(d.length).toBe(a.length);
      }
      expect(d.toArray()).toEqual(a);
      expect(d.listpackBytes).toBe(DatabaseService.listpackSize(a));
    }
  });
});
