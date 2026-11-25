/** A hash value: field → value (binary strings). */
export type HashValue = Map<string, string>;

/** Field TTLs of one hash: field → absolute expiry time in ms. */
export type FieldExpires = Map<string, number>;
