import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { colors, contrastPairs, darkColors, forbiddenPairs, lightColors, radii, shadows, type ColorToken } from "../src/tokens/tokens";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** Parse `--name: value;` declarations inside the first block whose header matches. */
function declarations(css: string, header: RegExp): Record<string, string> {
	const m = header.exec(css);
	if (!m) throw new Error(`block not found: ${header}`);
	let depth = 0;
	let i = css.indexOf("{", m.index);
	const start = i + 1;
	for (; i < css.length; i++) {
		if (css[i] === "{") depth++;
		if (css[i] === "}" && --depth === 0) break;
	}
	const body = css.slice(start, i);
	const out: Record<string, string> = {};
	for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim().replace(/\s+/g, " ");
	return out;
}

// Contrast (WCAG 2.x relative luminance)
function lum(hex: string): number {
	const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

const site = read("../../../docs/design/site-globals.css");
const tokensCss = read("../src/styles/tokens.css");
const siteLight = declarations(site, /^:root\s*{/m);
const siteDark = declarations(site, /@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{/m);
const ourLight = declarations(tokensCss, /^:root\s*{/m);
const ourDarkMedia = declarations(tokensCss, /:root:not\(\[data-theme="light"\]\)\s*{/);
const ourDarkForced = declarations(tokensCss, /:root\[data-theme="dark"\]\s*{/);

describe("tokens.css vs website site-globals.css", () => {
	it("light tokens are identical to the website", () => {
		for (const [k, v] of Object.entries(siteLight)) expect(ourLight[k], k).toBe(v);
	});
	it("dark tokens are identical to the website", () => {
		for (const [k, v] of Object.entries(siteDark)) {
			expect(ourDarkMedia[k], `media ${k}`).toBe(v);
			expect(ourDarkForced[k], `forced ${k}`).toBe(v);
		}
	});
	it("prefers-color-scheme and data-theme=dark blocks agree", () => {
		const { ["color-scheme"]: _a, ...media } = ourDarkMedia as Record<string, string>;
		expect(ourDarkForced).toEqual(media);
	});
	it("only documented additions beyond the website set", () => {
		const extra = Object.keys(ourLight).filter((k) => !(k in siteLight));
		expect(extra.sort()).toEqual(["--control-border", "--font-geist-mono", "--font-geist-sans"]);
	});
});

describe("tokens.ts mirrors tokens.css", () => {
	it("colours", () => {
		for (const [k, v] of Object.entries(lightColors)) expect(ourLight[`--${k}`], k).toBe(v);
		for (const [k, v] of Object.entries(darkColors)) {
			expect(ourDarkForced[`--${k}`] ?? ourLight[`--${k}`], `dark ${k}`).toBe(v);
		}
	});
	it("radii and shadows", () => {
		for (const [k, v] of Object.entries(radii)) expect(ourLight[`--r-${k}`], k).toBe(v);
		for (const [k, v] of Object.entries(shadows.light)) expect(ourLight[`--shadow-${k}`], k).toBe(v);
		for (const [k, v] of Object.entries(shadows.dark)) expect(ourDarkForced[`--shadow-${k}`], k).toBe(v);
	});
	it("every colour token is mapped in the Tailwind theme", () => {
		const theme = read("../src/styles/theme.css");
		for (const k of Object.keys(lightColors) as ColorToken[]) {
			const name = k === "control-border" ? "control" : k;
			expect(theme, k).toContain(`--color-${name}: var(--${k});`);
		}
	});
});

describe("contrast (WCAG AA)", () => {
	for (const mode of ["light", "dark"] as const) {
		describe(mode, () => {
			for (const p of contrastPairs) {
				it(`${p.fg} on ${p.bg} ≥ ${p.min} (${p.note})`, () => {
					const ratio = contrast(colors[mode][p.fg], colors[mode][p.bg]);
					expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(p.min);
				});
			}
		});
	}
});

describe("known failing pairs stay documented", () => {
	for (const p of forbiddenPairs) {
		it(`${p.fg} on ${p.bg} (${p.mode}) is below AA, so it is listed as forbidden`, () => {
			expect(contrast(colors[p.mode][p.fg], colors[p.mode][p.bg])).toBeLessThan(4.5);
		});
	}
});
