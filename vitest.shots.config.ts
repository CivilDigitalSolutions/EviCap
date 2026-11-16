import { defineConfig } from 'vitest/config';

// Store screenshots: `npm run store:shots` builds the e2e extension and runs tools/store-shots.shots.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/**/*.shots.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
