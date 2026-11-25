import { AppError } from '@/libs/app-error';

import { Acl } from '../acl.service';

/** Shared fixtures of the ACL unit tests: a small command table with categories, and error helpers. */

const CATS: Record<string, string[]> = {
  get: ['@read', '@string', '@fast'],
  set: ['@write', '@string', '@slow'],
  del: ['@keyspace', '@write', '@slow'],
  copy: ['@keyspace', '@write', '@slow'],
  hget: ['@read', '@hash', '@fast'],
  lpush: ['@write', '@list', '@fast'],
  select: ['@fast', '@connection'],
  auth: ['@fast', '@connection'],
  publish: ['@pubsub', '@fast'],
  subscribe: ['@pubsub', '@slow'],
  psubscribe: ['@pubsub', '@slow'],
  flushall: ['@keyspace', '@write', '@slow', '@dangerous'],
  config: ['@slow'],
  'config|get': ['@admin', '@slow', '@dangerous'],
  'config|set': ['@admin', '@slow', '@dangerous'],
  client: ['@slow'],
  'client|getname': ['@slow', '@connection'],
  'client|kill': ['@admin', '@slow', '@dangerous', '@connection'],
};

export const FOO_HASH = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';

export function makeAcl(opts: { requirepass?: string; now?: () => number; logMaxLen?: number } = {}): Acl {
  return new Acl({ allCommands: () => Object.keys(CATS), categoriesOf: (c) => CATS[c] ?? [], ...opts });
}

export function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.message;
    throw e;
  }
  throw new Error('expected an error');
}

export const rw = (key: string) => ({ key, read: true, write: true });
export const r = (key: string) => ({ key, read: true, write: false });
export const w = (key: string) => ({ key, read: false, write: true });
