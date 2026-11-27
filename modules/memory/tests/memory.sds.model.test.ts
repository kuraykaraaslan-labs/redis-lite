import { describe, expect, it } from 'vitest';

import MemoryService from '../memory.service';
import type { StringValue } from '../memory.types';

const { sdsFresh, sdsMakeRoom, stringSds, modifiedString } = MemoryService;

const str = (value: string, extra: Partial<StringValue> = {}): StringValue => ({ type: 'string', value, ...extra });

describe('sds allocations of string values (Redis 7.0)', () => {
  it('a fresh sds keeps the usable size as capacity (none for sdshdr5)', () => {
    expect(sdsFresh(0)).toEqual({ size: 8, cap: 4 });
    expect(sdsFresh(3)).toEqual({ size: 8, cap: 3 });
    expect(sdsFresh(50)).toEqual({ size: 64, cap: 60 });
    expect(sdsFresh(16384)).toEqual({ size: 20480, cap: 20474 });
  });

  it('growth doubles below 1 MB and adds 1 MB above', () => {
    expect(sdsMakeRoom({ size: 8, cap: 1 }, 1, 1)).toEqual({ size: 8, cap: 4 });
    expect(sdsMakeRoom({ size: 8, cap: 4 }, 2, 42)).toEqual({ size: 96, cap: 92 });
    expect(sdsMakeRoom({ size: 96, cap: 92 }, 45, 1)).toEqual({ size: 96, cap: 92 });
    expect(sdsMakeRoom(sdsFresh(2_000_001), 2_000_001, 1).size).toBe(2_097_152);
  });

  it('a SET value is trimmed when its spare room exceeds a tenth of its length', () => {
    expect(stringSds(str('x'.repeat(50)))).toEqual({ size: 64, cap: 50 });
    expect(stringSds(str('x'.repeat(60)))).toEqual({ size: 64, cap: 60 });
    // an embstr / int value is unshared into an exact raw copy
    expect(stringSds(str('12345'))).toEqual({ size: 8, cap: 5 });
  });

  it('in-place writes keep or grow the allocation', () => {
    expect(modifiedString(undefined, 13)).toEqual({ size: 16, cap: 13 });
    expect(modifiedString(str('x'.repeat(50)), 51)).toEqual({ size: 112, cap: 108 });
    const grown = str('x'.repeat(51), { raw: true, sds: { size: 112, cap: 108 } });
    expect(modifiedString(grown, 100)).toEqual({ size: 112, cap: 108 });
  });
});

describe('value dicts (rehashing)', () => {
  const { dictSnapshot, dictAfterCommand, dictSlots } = MemoryService;
  const none = dictSnapshot(undefined, 0, false);

  it('a dict that just grew counts both tables until it rehashed', () => {
    const set = new Set(['a', 'b', 'c', 'd', 'e']);
    dictAfterCommand(none, set, 5, true, 'set', 5, (b) => b);
    expect(dictSlots(set, 5)).toBe(4 + 8);
    for (let i = 0; i < 20; i++) dictAfterCommand(dictSnapshot(set, 5, true), set, 5, true, 'set', 1, (b) => b);
    expect(dictSlots(set, 5)).toBe(8);
  });

  it('a converted dict is preallocated to its size at the conversion', () => {
    const set = new Set(Array.from({ length: 600 }, (_, i) => String(i)));
    dictAfterCommand(none, set, 600, true, 'set', 600, () => 513);
    expect(dictSlots(set, 600)).toBe(1024);
  });

  it('an untracked dict is settled', () => {
    expect(dictSlots(new Set(['a']), 300)).toBe(512);
  });
});
