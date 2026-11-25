import { expect } from 'vitest';

import { ListDeque } from '@/modules/lists/lists.deque.structure';

/**
 * Global test setup. A list value (ListDeque) equals an array or another ListDeque holding the same elements, so
 * assertions can keep writing expected lists as arrays (`toEqual({ type: 'list', value: ['a', 'b'] })`).
 */
expect.addEqualityTesters([
  function listDequeEquality(a: unknown, b: unknown, customTesters) {
    const aList = a instanceof ListDeque;
    const bList = b instanceof ListDeque;
    if (!aList && !bList) return undefined;
    if (!(aList || Array.isArray(a)) || !(bList || Array.isArray(b))) return undefined;
    return this.equals([...(a as Iterable<unknown>)], [...(b as Iterable<unknown>)], customTesters);
  },
]);
