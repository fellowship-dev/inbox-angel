import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The gallery consumes the package source directly, the same way an app would consume the build.
export default defineConfig({
	root: import.meta.dirname,
	base: "./",
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@inbox-angel/ui": new URL("../src/index.ts", import.meta.url).pathname } },
	build: { outDir: "dist", emptyOutDir: true },
	server: { port: 5199, host: "127.0.0.1" },
	preview: { port: 5199, host: "127.0.0.1" },
});
