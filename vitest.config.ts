import { defineConfig } from 'vitest/config';

// Engine tests spawn real child processes (tsc, eslint) in e2e suites;
// give them generous time without weakening unit suites.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ['packages/**/*.{test,spec}.ts'],
    // Custom include replaces vitest's default excludes; nested copies of the
    // same packages live under packages/*/node_modules/@pe/* (pnpm symlinks)
    // and must not run: they double-collect every suite and their .bin lacks
    // the e2e tools (tsc/eslint), which stalls scans and times out.
    exclude: ['**/node_modules/**', 'packages/extension/test-electron/**'],
  },
});
