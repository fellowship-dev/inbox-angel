import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Exercises the BUILT package in plain Node via its public specifiers (package self-reference), not the src alias.
const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");

const node = (code: string) =>
	execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8" }).trim();

describe("built package (dist) in Node ESM", () => {
	it("is built (run `npm run build`; `npm test` does it)", () => {
		expect(existsSync(join(dist, "index.js"))).toBe(true);
	});
	it("main entry imports and exports the components", () => {
		const out = node(`const m = await import("@inbox-angel/ui"); console.log(JSON.stringify(["Button","Dialog","AppShell","LevelCard","RecordBlock","Toaster","buttonVariants","colors"].map(k => typeof m[k])))`);
		expect(JSON.parse(out)).toEqual(["object", "function", "function", "object", "object", "function", "function", "object"]);
	});
	it("server entry imports and server-renders without a client runtime", () => {
		const out = node(`
			import { createElement as h } from "react";
			import { renderToString } from "react-dom/server";
			const m = await import("@inbox-angel/ui/server");
			console.log(renderToString(h("div", null, h(m.Badge, { variant: "success" }, "Pass"), h(m.StatusDot, { status: "ok", label: "Healthy" }), h(m.LevelCard, { level: 1, domain: "example.test" }))));
		`);
		expect(out).toContain("Pass");
		expect(out).toContain("Healthy");
		expect(out).toContain("Level 1");
	});
	it("tokens entry imports", () => {
		expect(node(`const t = await import("@inbox-angel/ui/tokens"); console.log(t.colors.light.brand)`)).toBe("#0b1f3a");
	});
	it("keeps the \"use client\" directive in the build output of interactive components", () => {
		for (const f of ["button", "dialog", "select", "toast", "app-shell", "record-block", "check-result", "tooltip", "tabs", "dropdown-menu", "checkbox", "switch", "label", "icon-button"]) {
			expect(readFileSync(join(dist, "components", `${f}.js`), "utf8").trimStart(), f).toMatch(/^["']use client["'];/);
		}
	});
	it("nothing reachable from the server entry is a client module or uses Radix/state", () => {
		const seen = new Set<string>();
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			const src = readFileSync(file, "utf8");
			expect(src, file).not.toMatch(/^\s*["']use client["']/);
			expect(src, file).not.toMatch(/@radix-ui|useState|useEffect|useRef|useSyncExternalStore/);
			for (const m of src.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) walk(join(dirname(file), m[1]!));
		};
		walk(join(dist, "server.js"));
		expect(seen.size).toBeGreaterThan(10);
		expect([...seen].some((f) => f.endsWith("button.js"))).toBe(false);
	});
	it("ships the css entries", () => {
		expect(readdirSync(join(dist, "styles")).sort()).toEqual(["base.css", "styles.css", "theme.css", "tokens.css"]);
	});
});
