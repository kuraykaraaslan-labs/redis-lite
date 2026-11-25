/** A set of keys with O(1) add / delete / uniform random pick (Redis samples dict buckets; a Map cannot be indexed). */
export class KeySampler {
  private readonly list: string[] = [];
  private readonly index = new Map<string, number>();

  get size(): number {
    return this.list.length;
  }

  add(key: string): void {
    if (this.index.has(key)) return;
    this.index.set(key, this.list.length);
    this.list.push(key);
  }

  delete(key: string): void {
    const i = this.index.get(key);
    if (i === undefined) return;
    const last = this.list.pop() as string;
    this.index.delete(key);
    if (last !== key) {
      this.list[i] = last;
      this.index.set(last, i);
    }
  }

  clear(): void {
    this.list.length = 0;
    this.index.clear();
  }

  /** Up to `count` keys picked at random (with replacement when the set is small; duplicates removed). */
  sample(count: number): string[] {
    const n = this.list.length;
    if (!n) return [];
    if (n <= count) return [...this.list];
    const out = new Set<string>();
    for (let tries = 0; out.size < count && tries < count * 3; tries++) out.add(this.list[Math.floor(Math.random() * n)]);
    return [...out];
  }

  random(): string | undefined {
    return this.list.length ? this.list[Math.floor(Math.random() * this.list.length)] : undefined;
  }
}
