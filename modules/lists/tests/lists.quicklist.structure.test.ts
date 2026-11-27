import { describe, expect, it } from 'vitest';

import { ListDeque } from '../lists.deque.structure';

/**
 * Quicklist node layout (no server). Every expected layout was observed on a real Redis 7.0 through DUMP (each node of
 * a DUMP payload is one listpack), so these tests pin the 7.0 node rules.
 */
const counts = (d: ListDeque): number[] => d.layout.nodes.map((n) => n.count);
const bytes = (d: ListDeque): number[] => d.layout.nodes.map((n) => n.bytes);
const ints = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i));
const fill5 = (n: number): ListDeque => ListDeque.from(ints(n), 5);

describe('quicklist fill', () => {
  it('a size limit takes elements while bytes + length + 8 fits', () => {
    expect(counts(ListDeque.from(Array(1400).fill('a'), -1))[0]).toBe(1361);
    expect(counts(ListDeque.from(Array(1100).fill('aa'), -1))[0]).toBe(1020);
    expect(counts(ListDeque.from(Array(50).fill('a'.repeat(100)), -1))[0]).toBe(39);
    expect(counts(ListDeque.from(Array(1000).fill('1234567'), -1))[0]).toBe(815); // integers count their text length
    expect(bytes(ListDeque.from(Array(70).fill('a'.repeat(1000)), -5))).toEqual([65267, 5027]);
  });

  it('a count limit also keeps nodes within 8 KB', () => {
    expect(counts(fill5(23))).toEqual([5, 5, 5, 5, 3]);
    expect(counts(ListDeque.from(Array(3).fill('a'.repeat(4086)), 3))).toEqual([2, 1]);
    expect(counts(ListDeque.from(Array(3).fill('a'.repeat(4087)), 3))).toEqual([1, 1, 1]);
    expect(counts(ListDeque.from(['a', 'b', 'c'], 0))).toEqual([1, 1, 1]);
  });

  it('a large element is a listpack node of its own', () => {
    const d = ListDeque.from(['x'.repeat(9000)]);
    d.push('a');
    expect(bytes(d)).toEqual([9014, 10]);
  });

  it('pushes at the head fill the head node; pops drop emptied nodes', () => {
    const d = new ListDeque(undefined, 5);
    for (const x of ints(13)) d.unshift(x);
    expect(counts(d)).toEqual([3, 5, 5]);
    d.push('x');
    expect(counts(d)).toEqual([3, 5, 5, 1]);
    d.splice(0, 3);
    expect(counts(d)).toEqual([5, 5, 1]);
    d.pop();
    d.pop();
    d.pop();
    expect(counts(d)).toEqual([5, 3]);
  });
});

describe('quicklist inserts (LINSERT)', () => {
  it('splits a full node; the new element joins the new part', () => {
    const d = fill5(23);
    d.insertAt(7, true, 'x'); // before 7: [5 6 x] [7 8 9]
    expect(counts(d)).toEqual([5, 3, 3, 5, 5, 3]);
    d.insertAt(9, true, 'y'); // before 7, head of a node with room
    expect(counts(d)).toEqual([5, 3, 4, 5, 5, 3]);
    const a = fill5(15);
    a.insertAt(7, false, 'x'); // after 7: [5 6 7] [x 8 9]
    expect(counts(a)).toEqual([5, 3, 3, 5]);
  });

  it('a full node passes an insert at its edge to the neighbour, or opens a node', () => {
    const d = fill5(10);
    d.insertAt(0, true, 'h');
    expect(counts(d)).toEqual([1, 5, 5]);
    const e = fill5(10);
    e.insertAt(5, false, 'x'); // after 5 (offset 0 of the full second node): split
    expect(counts(e)).toEqual([5, 1, 5]);
    const f = fill5(10);
    f.insertAt(4, false, 'x'); // after the last element of a full node: a new node
    expect(counts(f)).toEqual([5, 1, 5]);
  });

  it('split parts merge with their neighbours', () => {
    const d = fill5(15);
    d.removeIndices([0, 1, 2, 3, 11, 12, 13, 14]); // [4] [5 .. 9] [10]
    expect(counts(d)).toEqual([1, 5, 1]);
    d.insertAt(3, true, 'x'); // before 7
    expect(counts(d)).toEqual([4, 4]);
    const big = ListDeque.from(Array.from({ length: 80 }, (_, i) => String(i).padStart(3, '0') + 'a'.repeat(97)), -1);
    big.insertAt(20, true, 'x'.repeat(73));
    expect(bytes(big)).toEqual([4100, 4024, 213]);
    const big2 = ListDeque.from(Array.from({ length: 80 }, (_, i) => String(i).padStart(3, '0') + 'a'.repeat(97)), -1);
    big2.insertAt(20, true, 'x'.repeat(74));
    expect(counts(big2)).toEqual([21, 19, 39, 2]);
  });
});

describe('copies and loads', () => {
  it('a clone keeps the nodes; a loaded list keeps the payload nodes or is laid out again', () => {
    const d = fill5(7);
    d.insertAt(2, true, 'x');
    expect(counts(d.clone())).toEqual(counts(d));
    const n = ListDeque.fromNodes([['a'], [], ['b'], ['c']]);
    n.adopt(2, 0);
    expect(counts(n)).toEqual([1, 1, 1]);
    expect(n.layout.fill).toBe(2);
    const l = ListDeque.loaded(['a', 'b', 'c', 'd', 'e']);
    l.adopt(2, 0);
    expect(counts(l)).toEqual([2, 2, 1]);
  });
});
