import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

/**
 * The Worker's server-rendered pages (agent consent and sign-in, src/mcp/consent.ts) load Geist from a fixed path.
 * The dashboard keeps using its hashed copies; this only adds the Latin subsets under /fonts/.
 */
const STABLE_FONTS = [
	['@fontsource-variable/geist', 'geist-latin-wght-normal.woff2'],
	['@fontsource-variable/geist-mono', 'geist-mono-latin-wght-normal.woff2'],
] as const;

function stableFonts(): Plugin {
	return {
		name: 'ready-set-mail-stable-fonts',
		apply: 'build',
		generateBundle() {
			for (const [pkg, file] of STABLE_FONTS) {
				this.emitFile({ type: 'asset', fileName: `fonts/${file}`, source: readFileSync(require.resolve(`${pkg}/files/${file}`)) });
			}
		},
	};
}

// Dev: `npm run dev` here proxies the API to `wrangler dev` on :8787.
export default defineConfig({
	plugins: [react(), tailwindcss(), stableFonts()],
	build: { outDir: 'dist', emptyOutDir: true },
	server: { proxy: { '/api': 'http://127.0.0.1:8787', '/health': 'http://127.0.0.1:8787' } },
	test: {
		environment: 'jsdom',
		globals: true,
		setupFiles: ['./test/setup.ts'],
		include: ['test/**/*.test.{ts,tsx}'],
	},
});
