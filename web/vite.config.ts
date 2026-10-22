import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dev: `npm run dev` here proxies the API to `wrangler dev` on :8787.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	build: { outDir: 'dist', emptyOutDir: true },
	server: { proxy: { '/api': 'http://127.0.0.1:8787', '/health': 'http://127.0.0.1:8787' } },
	test: {
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./test/setup.ts'],
		include: ['test/**/*.test.{ts,tsx}'],
	},
});
