/**
 * maxmemory eviction: the maxmemory-policy family, approximated the way the Redis eviction docs describe it.
 *
 * Written from the Redis documentation and observable behaviour; no Redis source code was consulted.
 *
 * - Before running a command (and when maxmemory is lowered), keys are evicted until used memory is back under
 *   maxmemory. Commands flagged `denyoom` get the OOM error when that is not possible.
 * - The LRU / LFU / TTL policies are approximated by sampling: every round takes `maxmemory-samples` random keys of each
 *   database (all keys, or only keys with a TTL for the volatile-* policies), merges them into a small pool of the best
 *   candidates seen so far, and evicts the best one. Random policies pick a random key, visiting databases in turn.
 * - maxmemory-eviction-tenacity bounds how long one pass may run: 0 is the shortest, 10 the default, 100 means no bound.
 *   When a pass runs out of time the rest of the work continues in the background and the command is not refused.
 */
import type { Database } from '../store/database';
import type { ServerConfig } from './config';

/** The documented OOM reply for denyoom commands. */
export const OOM_ERROR = "OOM command not allowed when used memory > 'maxmemory'.";

export type EvictionResult = 'ok' | 'running' | 'fail';

/** What the evictor needs from the server. */
export interface EvictionHost {
  readonly databases: readonly Database[];
  readonly config: ServerConfig;
  /** used_memory as maxmemory sees it (memory not counted for eviction already subtracted). */
  usedMemoryForEviction(): number;
  /** Deletes the key and does everything an eviction implies (notification, propagation, invalidation). */
  evictKey(dbIndex: number, key: string): void;
}

interface Candidate {
  db: number;
  key: string;
  /** Higher = better to evict. */
  score: number;
}

/** Candidates kept between rounds (Redis keeps a small pool too, so good candidates are not forgotten). */
const POOL_SIZE = 16;
/** How often the time bound is checked, in evicted keys. */
const TIME_CHECK_EVERY = 16;

/** The time one pass may take, from maxmemory-eviction-tenacity (this mapping is redis-lite's own). */
export function evictionTimeLimitMs(tenacity: number): number {
  if (tenacity >= 100) return Infinity;
  return 0.25 * Math.pow(1.12, tenacity);
}

export class Evictor {
  /** INFO stats evicted_keys. */
  evictedKeys = 0;
  /** INFO stats total_eviction_exceeded_time (ms). */
  private exceededTotalMs = 0;
  /** Start of the current period over maxmemory, or null. */
  private exceededSince: number | null = null;
  private pool: Candidate[] = [];
  private nextRandomDb = 0;
  private background: NodeJS.Immediate | null = null;

  constructor(private readonly host: EvictionHost) {}

  private get policy(): string {
    return this.host.config.get('maxmemory-policy') ?? 'noeviction';
  }

  /** INFO stats total_eviction_exceeded_time / current_eviction_exceeded_time, in ms. */
  exceededTime(now = Date.now()): { total: number; current: number } {
    const current = this.exceededSince === null ? 0 : now - this.exceededSince;
    return { total: this.exceededTotalMs + current, current };
  }

  resetStats(): void {
    this.evictedKeys = 0;
    this.exceededTotalMs = 0;
    if (this.exceededSince !== null) this.exceededSince = Date.now();
  }

  private overLimit(): boolean {
    const max = this.host.config.num('maxmemory');
    const over = max > 0 && this.host.usedMemoryForEviction() > max;
    const now = Date.now();
    if (over && this.exceededSince === null) this.exceededSince = now;
    else if (!over && this.exceededSince !== null) {
      this.exceededTotalMs += now - this.exceededSince;
      this.exceededSince = null;
    }
    return over;
  }

  /**
   * Frees memory until used memory is under maxmemory. 'ok': under the limit (or no limit); 'running': still over, the
   * rest continues in the background; 'fail': nothing (more) can be evicted.
   */
  perform(): EvictionResult {
    if (!this.overLimit()) return 'ok';
    if (this.background) return 'running';
    if (this.policy === 'noeviction') return 'fail';
    const started = performance.now();
    const limit = evictionTimeLimitMs(this.host.config.num('maxmemory-eviction-tenacity'));
    let evicted = 0;
    while (this.overLimit()) {
      const victim = this.pick();
      if (!victim) return 'fail';
      this.host.evictKey(victim.db, victim.key);
      this.evictedKeys++;
      evicted++;
      if (evicted % TIME_CHECK_EVERY === 0 && performance.now() - started > limit) {
        if (!this.overLimit()) return 'ok';
        this.continueInBackground();
        return 'running';
      }
    }
    return 'ok';
  }

  private continueInBackground(): void {
    this.background = setImmediate(() => {
      this.background = null;
      this.perform();
    });
  }

  /** Stops background eviction (server shutdown). */
  stop(): void {
    if (this.background) clearImmediate(this.background);
    this.background = null;
  }

  private pick(): Candidate | null {
    const policy = this.policy;
    const volatileOnly = policy.startsWith('volatile-');
    if (policy.endsWith('-random')) return this.pickRandom(volatileOnly);
    return this.pickFromPool(policy, volatileOnly);
  }

  private pickRandom(volatileOnly: boolean): Candidate | null {
    const dbs = this.host.databases;
    for (let tried = 0; tried < dbs.length; tried++) {
      const i = this.nextRandomDb;
      this.nextRandomDb = (this.nextRandomDb + 1) % dbs.length;
      const key = dbs[i].randomKeyFor(volatileOnly);
      if (key !== undefined) return { db: i, key, score: 0 };
    }
    return null;
  }

  private score(db: Database, key: string, policy: string, now: number): number {
    if (policy.endsWith('-lru')) return now - db.lastAccess(key);
    if (policy.endsWith('-lfu')) return 255 - db.frequency(key);
    // volatile-ttl: the sooner it expires, the better
    const at = db.getExpireRaw(key);
    return at === undefined ? -Infinity : Number.MAX_SAFE_INTEGER - at;
  }

  private pickFromPool(policy: string, volatileOnly: boolean): Candidate | null {
    const dbs = this.host.databases;
    const samples = this.host.config.num('maxmemory-samples') || 5;
    const now = Date.now();
    for (;;) {
      let sampled = 0;
      dbs.forEach((db, i) => {
        for (const key of db.sampleKeys(samples, volatileOnly)) {
          sampled++;
          if (this.pool.some((c) => c.db === i && c.key === key)) continue;
          this.offer({ db: i, key, score: this.score(db, key, policy, now) });
        }
      });
      if (!sampled && !this.pool.length) return null;
      // best candidate first; skip the ones that vanished (or lost their TTL) since they were pooled
      while (this.pool.length) {
        const best = this.pool.pop() as Candidate;
        const db = dbs[best.db];
        if (db.raw(best.key) === undefined) continue;
        if (volatileOnly && !db.hasExpireRaw(best.key)) continue;
        return best;
      }
      if (!sampled) return null;
    }
  }

  /** Inserts into the pool, kept sorted by ascending score and capped at POOL_SIZE (the worst falls out). */
  private offer(c: Candidate): void {
    const pool = this.pool;
    if (pool.length >= POOL_SIZE && c.score <= pool[0].score) return;
    let i = pool.length;
    while (i > 0 && pool[i - 1].score > c.score) i--;
    pool.splice(i, 0, c);
    if (pool.length > POOL_SIZE) pool.shift();
  }

  /** The policy changed or the dataset was replaced: pooled candidates are meaningless. */
  clearPool(): void {
    this.pool = [];
  }
}
