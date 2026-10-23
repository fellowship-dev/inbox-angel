// Separate vitest config for pure Node.js unit tests (parser, utils)
// These don't need the Workers runtime — faster feedback loop.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // packages/ui needs jsdom and a built dist: run it with `npm run test:ui`.
    exclude: ['test/index.spec.ts', 'packages/ui/**'],
    environment: 'node',
    setupFiles: ['test/setup-files/turnstile.ts'],
  },
});
