import { AppError } from '@/libs/app-error';

import type { CommandContext } from '@/modules/command/command.types';

import BitmapsMessages from './bitmaps.messages';

/**
 * Bitmaps operate on string values: each char of a binary string is one byte. The byte-array helpers shared by the
 * bitmap sub-services (which never import each other).
 */
export default class BitmapStore {
  // ──────────────────────────────────────────────
  // Constants
  // ──────────────────────────────────────────────

  /** String.fromCharCode takes its arguments on the stack: convert in chunks. */
  private static readonly CHUNK = 65536;

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The bytes of the string at `key` (empty when missing); WRONGTYPE for other types. */
  static read(ctx: CommandContext, key: string): number[] {
    const v = ctx.db.get(key, 'string') ?? '';
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i);
    return out;
  }

  /** Stores the bytes as a raw-encoded string, keeping the key's TTL. */
  static write(ctx: CommandContext, key: string, bytes: number[]): void {
    let value = '';
    for (let i = 0; i < bytes.length; i += BitmapStore.CHUNK) value += String.fromCharCode(...bytes.slice(i, i + BitmapStore.CHUNK));
    ctx.db.set(key, { type: 'string', value, raw: true }, true);
  }

  /** Bit offsets are limited so the string stays under proto-max-bulk-len, as in Redis. */
  static checkOffset(ctx: CommandContext, offset: number): void {
    if (Math.floor(offset / 8) >= ctx.server.config.num('proto-max-bulk-len')) throw new AppError(BitmapsMessages.BIT_OFFSET);
  }

  static getBit(bytes: number[], offset: number): number {
    const byte = bytes[offset >> 3] ?? 0;
    return (byte >> (7 - (offset & 7))) & 1;
  }

  /** Sets one bit, growing the array with zero bytes as needed. */
  static setBit(bytes: number[], offset: number, bit: number): void {
    const i = Math.floor(offset / 8);
    while (bytes.length <= i) bytes.push(0);
    const mask = 1 << (7 - (offset % 8));
    bytes[i] = bit ? bytes[i] | mask : bytes[i] & ~mask;
  }
}
