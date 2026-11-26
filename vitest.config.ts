import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const ROOT = resolve(__dirname);

/** Suites that wait a fixed time for background work (eviction cycles): they run last, on an otherwise idle machine. */
const TIMING_SENSITIVE = ['modules/memory/tests/memory.eviction.test.ts'];

/** Global setup of every suite (custom equality for list values). */
const SETUP = `${ROOT}/tests/setup.ts`;

/**
 * Per-test and per-hook budget. The default 5 s is too tight when the parallel suite shares the CPU with other work
 * (a 1 s test can take 10 s on a loaded machine); a real hang still fails, just later.
 */
const TIMEOUTS = { testTimeout: 30_000, hookTimeout: 30_000 };

// the `@/` alias of tsconfig.json: `@/libs/...`, `@/modules/...` resolve from the project root
const resolveAlias = { alias: [{ find: /^@\//, replacement: `${ROOT}/` }] };

export default defineConfig({
  resolve: resolveAlias,
  test: {
    projects: [
      {
        resolve: resolveAlias,
        test: {
          name: 'suites',
          include: ['**/*.test.ts'],
          exclude: ['node_modules/**', 'dist/**', ...TIMING_SENSITIVE],
          setupFiles: [SETUP],
          ...TIMEOUTS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: resolveAlias,
        test: { name: 'timing', include: TIMING_SENSITIVE, setupFiles: [SETUP], ...TIMEOUTS, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
