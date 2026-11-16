import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { verifierPlugin } from './tools/verifier-plugin';

export default defineConfig({
  plugins: [WxtVitest(), verifierPlugin()],
  define: { __EVICAP_E2E__: 'false' },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
