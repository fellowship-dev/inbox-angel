import { defineConfig } from '@playwright/test';

// e2e/ runs against a local `wrangler dev` by default (npm run dev → http://127.0.0.1:8787).
// Point E2E_BASE_URL elsewhere to target another instance — deliberately NOT production by default.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8787',
  },
});
