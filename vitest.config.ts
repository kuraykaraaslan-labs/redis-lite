import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const ROOT = resolve(__dirname);

/** Suites that wait a fixed time for background work (eviction cycles): they run last, on an otherwise idle machine. */
const TIMING_SENSITIVE = ['modules/memory/tests/memory.eviction.test.ts'];

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
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: resolveAlias,
        test: { name: 'timing', include: TIMING_SENSITIVE, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
