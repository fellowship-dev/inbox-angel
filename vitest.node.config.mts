// Separate vitest config for pure Node.js unit tests (parser, utils)
// These don't need the Workers runtime — faster feedback loop.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['test/index.spec.ts'],
    environment: 'node',
  },
});
