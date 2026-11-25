import { HLL_P, HLL_P_MASK, HLL_Q } from './hyperloglog.encoding';

/** Element hashing of the HyperLogLog: MurmurHash64A, then the register index and the run length it selects. */

const HASH_SEED = 0xadc83b19;

const M = 0xc6a4a7935bd1e995n;
const R = 47n;
const MASK64 = (1n << 64n) - 1n;

/** MurmurHash64A (Austin Appleby), little-endian block reads, as used by Redis. */
export function murmurHash64A(data: Uint8Array, seed: number): bigint {
  const len = data.length;
  let h = BigInt(seed >>> 0) ^ ((BigInt(len) * M) & MASK64);
  const blocksEnd = len - (len & 7);
  for (let i = 0; i < blocksEnd; i += 8) {
    const lo = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    const hi = (data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24)) >>> 0;
    let k = BigInt(lo) | (BigInt(hi) << 32n);
    k = (k * M) & MASK64;
    k ^= k >> R;
    k = (k * M) & MASK64;
    h ^= k;
    h = (h * M) & MASK64;
  }
  const rem = len & 7;
  if (rem) {
    for (let i = rem - 1; i >= 0; i--) h ^= BigInt(data[blocksEnd + i]) << BigInt(8 * i);
    h = (h * M) & MASK64;
  }
  h ^= h >> R;
  h = (h * M) & MASK64;
  h ^= h >> R;
  return h;
}

/** Register index (low P bits of the hash) and run length of the "000..1" pattern of the remaining bits (1..Q+1). */
export function hllPatLen(ele: Uint8Array): { index: number; count: number } {
  const hash = murmurHash64A(ele, HASH_SEED);
  const index = Number(hash & BigInt(HLL_P_MASK));
  // Remaining bits plus the sentinel bit Q, so the count is at most Q+1. Fits a double exactly (< 2^51).
  let rest = Number((hash >> BigInt(HLL_P)) | (1n << BigInt(HLL_Q)));
  let count = 1;
  while (rest % 2 === 0) {
    count++;
    rest /= 2;
  }
  return { index, count };
}
