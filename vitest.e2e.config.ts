import { defineConfig } from 'vitest/config';

// End-to-end tests: load the built extension (.output/chrome-mv3) into a real
// Chromium browser. Set EVICAP_BROWSER to a browser path; defaults to Edge on Windows.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
