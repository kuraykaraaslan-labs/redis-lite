import type { BitfieldOp, OverflowPolicy, RangeUnit } from './bitmaps.enums';

/** A BITFIELD integer type: `i<bits>` (signed, up to 64) or `u<bits>` (unsigned, up to 63). */
export type FieldType = {
  signed: boolean;
  bits: number;
};

/** A BITCOUNT / BITPOS range as given: `end` is null for BITPOS key bit start (to the end of the string). */
export type BitRangeArgs = {
  start: number;
  end: number | null;
  unit: RangeUnit;
};

/** One BITFIELD GET / SET / INCRBY, with the OVERFLOW policy in force where it stands. */
export type BitfieldStep = {
  op: BitfieldOp;
  type: FieldType;
  /** Bit offset (`#n` already multiplied by the type width). */
  offset: number;
  /** SET / INCRBY argument; null for GET. */
  value: bigint | null;
  policy: OverflowPolicy;
};

/**
 * A grammar error met after a bit offset: Redis checks each offset against proto-max-bulk-len as it reads it, so the
 * error is reported only once the offsets read before it (and `offset`, the one of the failing subcommand) pass.
 */
export type DeferredIssue = {
  message: string;
  offset: number | null;
};
