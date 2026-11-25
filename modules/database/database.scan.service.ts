import type { ScanPage } from './database.types';

/**
 * SCAN cursors. Like Redis, the cursor walks a fixed hash order, so every element present for the whole iteration is
 * returned (possibly more than once never: the order only depends on the element itself), new and deleted elements may
 * or may not show up, and cursor 0 ends the iteration. Cursor values are opaque, as in Redis.
 */
export default class DatabaseScanService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** FNV-1a: the fixed order cursors walk. */
  private static hash32(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** The page of `items` starting at `cursor`: at least `count` items (whole hash buckets), and the next cursor. */
  static scanPage(items: Iterable<string>, cursor: number, count: number): ScanPage {
    const ordered = [...items].map((item) => ({ item, h: DatabaseScanService.hash32(item) })).filter((x) => x.h >= cursor);
    ordered.sort((a, b) => (a.h !== b.h ? a.h - b.h : a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
    const page: string[] = [];
    let i = 0;
    while (i < ordered.length && page.length < count) {
      const h = ordered[i].h;
      // A whole hash bucket is returned at once, like Redis returns whole dict buckets.
      while (i < ordered.length && ordered[i].h === h) page.push(ordered[i++].item);
    }
    if (i >= ordered.length) return { next: 0, page };
    return { next: ordered[i].h, page };
  }
}
