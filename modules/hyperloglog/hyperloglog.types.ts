/** One sparse opcode: the registers [first, first+len) all hold `value` (0 for ZERO/XZERO). */
export type SparseRun = {
  kind: 'zero' | 'xzero' | 'val';
  value: number;
  len: number;
};
