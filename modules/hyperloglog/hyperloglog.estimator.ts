import { HLL_Q, HLL_REGISTERS } from './hyperloglog.encoding';

/** Cardinality estimator of a register histogram (Ertl, arXiv:1702.01284), as Redis computes it. */

const HLL_ALPHA_INF = 0.721347520444481703680;

function hllSigma(x: number): number {
  if (x === 1) return Infinity;
  let zPrime: number;
  let y = 1;
  let z = x;
  do {
    x *= x;
    zPrime = z;
    z += x * y;
    y += y;
  } while (zPrime !== z);
  return z;
}

function hllTau(x: number): number {
  if (x === 0 || x === 1) return 0;
  let zPrime: number;
  let y = 1.0;
  let z = 1 - x;
  do {
    x = Math.sqrt(x);
    zPrime = z;
    y *= 0.5;
    const d = 1 - x;
    z -= d * d * y;
  } while (zPrime !== z);
  return z / 3;
}

export function estimate(histo: number[]): number {
  const m = HLL_REGISTERS;
  let z = m * hllTau((m - histo[HLL_Q + 1]) / m);
  for (let j = HLL_Q; j >= 1; --j) {
    z += histo[j];
    z *= 0.5;
  }
  z += m * hllSigma(histo[0] / m);
  // llroundl: round half away from zero (the value is never negative).
  return Math.round((HLL_ALPHA_INF * m * m) / z);
}
