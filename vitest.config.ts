import { defineConfig } from 'vitest/config';

// Engine tests spawn real child processes (tsc, eslint) in e2e suites;
// give them generous time without weakening unit suites.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ['packages/**/*.{test,spec}.ts'],
    exclude: ['packages/extension/test-electron/**'],
  },
});
