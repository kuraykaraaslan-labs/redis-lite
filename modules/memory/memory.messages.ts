/** Every text the memory module emits, word for word as Redis sends it. */
export const MemoryMessages = {
  /** The documented OOM reply for denyoom commands (without the leading '-'). */
  OOM: "OOM command not allowed when used memory > 'maxmemory'.",
} as const;

export default MemoryMessages;
