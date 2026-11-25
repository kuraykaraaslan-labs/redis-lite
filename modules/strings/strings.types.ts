/** A run of common characters found by LCS: inclusive positions in the first (a) and second (b) string. */
export type LcsMatchRange = {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
};
