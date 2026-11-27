import { describe, expect, it } from 'vitest';

import MemoryService from '../memory.service';

const { dictBuckets, embstrAllocSize, jemallocSize, keyAllocSize, sdsAllocSize, sdsReqType } = MemoryService;

describe('jemallocSize', () => {
  it('rounds to jemalloc size classes', () => {
    const cases: Array<[number, number]> = [
      [0, 8], [1, 8], [8, 8], [9, 16], [16, 16], [17, 32], [33, 48], [100, 112], [128, 128], [129, 160],
      [200, 224], [256, 256], [257, 320], [500, 512], [513, 640], [1000, 1024], [1025, 1280], [4000, 4096],
      [4097, 5120], [8193, 10240], [14337, 16384], [16385, 20480], [100010, 114688], [1 << 20, 1 << 20],
    ];
    for (const [n, want] of cases) expect(jemallocSize(n)).toBe(want);
  });

  it('is monotonic and never smaller than the request', () => {
    let prev = 0;
    for (let n = 0; n < 70000; n += 7) {
      const s = jemallocSize(n);
      expect(s).toBeGreaterThanOrEqual(n);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe('sds', () => {
  it('picks header types like sdsReqType', () => {
    expect(sdsReqType(0)).toBe(5);
    expect(sdsReqType(31)).toBe(5);
    expect(sdsReqType(32)).toBe(8);
    expect(sdsReqType(252)).toBe(8);
    expect(sdsReqType(253)).toBe(16);
    expect(sdsReqType(65530)).toBe(16);
    expect(sdsReqType(65531)).toBe(32);
  });

  it('allocation sizes', () => {
    expect(sdsAllocSize(0)).toBe(8); // sdshdr8 for empty strings: 3 + 0 + 1
    expect(sdsAllocSize(3)).toBe(8); // hdr5: 1 + 3 + 1 = 5
    expect(sdsAllocSize(31)).toBe(48); // 1 + 31 + 1 = 33
    expect(sdsAllocSize(32)).toBe(48); // 3 + 32 + 1 = 36
    expect(sdsAllocSize(100)).toBe(112);
    expect(sdsAllocSize(3, 8)).toBe(8);
  });
});

describe('keys and embstr objects (Redis 7.0)', () => {
  it('the key is its own sds; an embstr holds robj + sdshdr8 + bytes + NUL', () => {
    expect(keyAllocSize('foo')).toBe(8); // hdr5 1 + 3 + NUL
    expect(keyAllocSize('k'.repeat(40))).toBe(48); // hdr8 3 + 40 + 1 = 44
    expect(keyAllocSize('')).toBe(8); // empty: hdr8
    expect(embstrAllocSize(5)).toBe(32); // 16 + 3 + 5 + 1 = 25
    expect(embstrAllocSize(44)).toBe(64);
  });
});


describe('dict buckets', () => {
  it('grows to the next power of two, minimum 4', () => {
    expect([0, 1, 4, 5, 8, 9, 128, 129].map(dictBuckets)).toEqual([0, 4, 4, 8, 8, 16, 128, 256]);
  });
});
