import { constants } from 'node:buffer';

import { AppError } from '@/libs/app-error';

import type { CommandContext } from '@/modules/command/command.types';
import MemoryService from '@/modules/memory/memory.service';

import BitmapsMessages from './bitmaps.messages';

/**
 * Bitmaps operate on string values: each char of a binary string is one byte. The byte-array helpers shared by the
 * bitmap sub-services (which never import each other).
 */
export default class BitmapStore {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /**
   * The longest string this engine can hold (the JS string limit, a little under 512 MB). Redis grows a bitmap up to
   * proto-max-bulk-len; a bitmap that would outgrow this limit is refused with Redis's offset error instead.
   */
  private static readonly MAX_BYTES = constants.MAX_STRING_LENGTH;

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The bytes of the string at `key` (empty when missing); WRONGTYPE for other types. */
  static read(ctx: CommandContext, key: string): Uint8Array {
    return Buffer.from(ctx.db.get(key, 'string') ?? '', 'latin1');
  }

  /** The bytes of the string at `key`, or null when the key is missing (an empty string is not missing). */
  static readExisting(ctx: CommandContext, key: string): Uint8Array | null {
    const v = ctx.db.get(key, 'string');
    return v === undefined ? null : Buffer.from(v, 'latin1');
  }

  /**
   * Stores the bytes as a raw-encoded string, keeping the key's TTL. `inPlace`: the existing value was modified (SETBIT,
   * BITFIELD: its allocation grows greedily); otherwise the value is new (BITOP).
   */
  static write(ctx: CommandContext, key: string, bytes: Uint8Array, inPlace = true): void {
    const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
    const prev = inPlace ? ctx.db.raw(key) : undefined;
    const sds = MemoryService.modifiedString(prev?.type === 'string' ? prev : undefined, value.length);
    ctx.db.set(key, { type: 'string', value, raw: true, sds }, true);
  }

  /** Bit offsets are limited so the string stays under proto-max-bulk-len, as in Redis. */
  static checkOffset(ctx: CommandContext, offset: number): void {
    if (Math.floor(offset / 8) >= ctx.server.config.num('proto-max-bulk-len')) throw new AppError(BitmapsMessages.BIT_OFFSET);
  }

  /** `bytes` grown with zero bytes to at least `size` bytes (a new array when it grows). */
  static grow(bytes: Uint8Array, size: number): Uint8Array {
    if (bytes.length >= size) return bytes;
    if (size > BitmapStore.MAX_BYTES) throw new AppError(BitmapsMessages.BIT_OFFSET);
    const grown = new Uint8Array(size);
    grown.set(bytes);
    return grown;
  }

  static getBit(bytes: Uint8Array, offset: number): number {
    const byte = bytes[Math.floor(offset / 8)] ?? 0;
    return (byte >> (7 - (offset & 7))) & 1;
  }

  /** Sets one bit, growing the bytes as needed; returns the (possibly new) bytes. */
  static setBit(bytes: Uint8Array, offset: number, bit: number): Uint8Array {
    const i = Math.floor(offset / 8);
    const out = BitmapStore.grow(bytes, i + 1);
    const mask = 1 << (7 - (offset & 7));
    out[i] = bit ? out[i] | mask : out[i] & ~mask;
    return out;
  }
}
