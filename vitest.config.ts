import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { verifierPlugin } from './tools/verifier-plugin';

export default defineConfig({
  plugins: [WxtVitest(), verifierPlugin()],
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
