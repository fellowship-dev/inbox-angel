/** Design tokens for JS consumers (charts, canvas, email templates). Mirrors styles/tokens.css. */

export const lightColors = {
	"surface-0": "#f7f8fa",
	"surface-1": "#ffffff",
	"surface-2": "#eff2f6",
	"surface-3": "#e3e9f0",
	"ink-1": "#0b1f3a",
	"ink-2": "#526175",
	"ink-3": "#617185",
	brand: "#0b1f3a",
	"brand-hover": "#173a63",
	"brand-ink": "#0b1f3a",
	"brand-subtle": "#e8eef5",
	"brand-fg": "#ffffff",
	accent: "#fad172",
	"accent-hover": "#f5c04a",
	"accent-fg": "#0b1f3a",
	"accent-subtle": "#fef7e3",
	blush: "#fca0a4",
	success: "#15803d",
	"success-subtle": "#ecfdf3",
	warning: "#b45309",
	"warning-subtle": "#fff7e6",
	danger: "#b91c1c",
	"danger-subtle": "#fef2f2",
	line: "#d7dfe8",
	"line-strong": "#b8c5d4",
	"control-border": "#617185",
	focus: "#0b1f3a",
} as const;

export type ColorToken = keyof typeof lightColors;

/** Dark values; tokens absent here keep their light value (as on the website). */
export const darkOverrides = {
	"surface-0": "#0b1220",
	"surface-1": "#142238",
	"surface-2": "#1c2e47",
	"surface-3": "#293d58",
	"ink-1": "#f4f7fb",
	"ink-2": "#a8b5c7",
	"ink-3": "#8a9bb1",
	brand: "#fad172",
	"brand-hover": "#ffe09a",
	"brand-ink": "#fad172",
	"brand-subtle": "#332c1d",
	"brand-fg": "#0b1f3a",
	"accent-fg": "#0b1f3a",
	"accent-subtle": "#2a2210",
	success: "#4ade80",
	"success-subtle": "#0f2a1a",
	warning: "#fbbf24",
	"warning-subtle": "#2a2110",
	danger: "#f87171",
	"danger-subtle": "#2c1416",
	line: "#33465f",
	"line-strong": "#50647e",
	"control-border": "#8a9bb1",
	focus: "#fad172",
} as const satisfies Partial<Record<ColorToken, string>>;

export const darkColors: Record<ColorToken, string> = { ...lightColors, ...darkOverrides };

export const colors = { light: lightColors, dark: darkColors } as const;

export const radii = {
	sm: "0.375rem",
	md: "0.625rem",
	lg: "0.875rem",
	xl: "1.25rem",
	"2xl": "1.5rem",
	full: "9999px",
} as const;

export const shadows = {
	light: {
		sm: "0 1px 2px 0 rgb(15 23 42 / 0.05)",
		md: "0 4px 6px -1px rgb(15 23 42 / 0.07), 0 2px 4px -2px rgb(15 23 42 / 0.05)",
		lg: "0 10px 15px -3px rgb(15 23 42 / 0.07), 0 4px 6px -4px rgb(15 23 42 / 0.05)",
		xl: "0 20px 25px -5px rgb(15 23 42 / 0.08), 0 8px 10px -6px rgb(15 23 42 / 0.04)",
	},
	dark: {
		sm: "0 1px 2px 0 rgb(0 0 0 / 0.3)",
		md: "0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3)",
		lg: "0 10px 15px -3px rgb(0 0 0 / 0.4), 0 4px 6px -4px rgb(0 0 0 / 0.3)",
		xl: "0 20px 25px -5px rgb(0 0 0 / 0.5), 0 8px 10px -6px rgb(0 0 0 / 0.3)",
	},
} as const;

export const fonts = {
	sans: '"Geist Variable", ui-sans-serif, system-ui, -apple-system, sans-serif',
	mono: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** CSS custom-property reference for a colour token: `cssVar("brand-ink")` → `var(--brand-ink)`. */
export const cssVar = (token: ColorToken): string =>
	token === "control-border" ? "var(--control-border)" : `var(--${token})`;

/** Contrast pairs the design commits to (checked in test/tokens.test.ts). */
export const contrastPairs: ReadonlyArray<{ fg: ColorToken; bg: ColorToken; min: number; note: string }> = [
	{ fg: "ink-1", bg: "surface-0", min: 4.5, note: "body on page" },
	{ fg: "ink-1", bg: "surface-1", min: 4.5, note: "body on card" },
	{ fg: "ink-1", bg: "surface-2", min: 4.5, note: "body on raised" },
	{ fg: "ink-2", bg: "surface-0", min: 4.5, note: "secondary on page" },
	{ fg: "ink-2", bg: "surface-1", min: 4.5, note: "secondary on card" },
	{ fg: "ink-2", bg: "surface-2", min: 4.5, note: "secondary on raised" },
	{ fg: "ink-3", bg: "surface-0", min: 4.5, note: "subtle on page" },
	{ fg: "ink-3", bg: "surface-1", min: 4.5, note: "subtle on card" },
	{ fg: "brand-fg", bg: "brand", min: 4.5, note: "button label" },
	{ fg: "brand-fg", bg: "brand-hover", min: 4.5, note: "button label, hover" },
	{ fg: "brand-ink", bg: "surface-0", min: 4.5, note: "link on page" },
	{ fg: "brand-ink", bg: "surface-1", min: 4.5, note: "link on card" },
	{ fg: "brand-ink", bg: "surface-2", min: 4.5, note: "link on raised" },
	{ fg: "brand-ink", bg: "brand-subtle", min: 4.5, note: "link on tint" },
	{ fg: "accent-fg", bg: "accent", min: 4.5, note: "text on gold" },
	{ fg: "ink-1", bg: "accent-subtle", min: 4.5, note: "text on gold tint (accent-fg is not themed for dark, so do not use it here)" },
	{ fg: "ink-1", bg: "brand-subtle", min: 4.5, note: "text on brand tint" },
	{ fg: "ink-2", bg: "brand-subtle", min: 4.5, note: "secondary on brand tint" },
	{ fg: "success", bg: "surface-1", min: 4.5, note: "pass text on card" },
	{ fg: "success", bg: "success-subtle", min: 4.5, note: "pass text on tint" },
	{ fg: "warning", bg: "surface-1", min: 4.5, note: "warn text on card" },
	{ fg: "warning", bg: "warning-subtle", min: 4.5, note: "warn text on tint" },
	{ fg: "danger", bg: "surface-1", min: 4.5, note: "fail text on card" },
	{ fg: "danger", bg: "danger-subtle", min: 4.5, note: "fail text on tint" },
	{ fg: "control-border", bg: "surface-1", min: 3, note: "input edge on card" },
	{ fg: "control-border", bg: "surface-0", min: 3, note: "input edge on page" },
	{ fg: "focus", bg: "surface-1", min: 3, note: "focus ring on card" },
	{ fg: "focus", bg: "surface-0", min: 3, note: "focus ring on page" },
	{ fg: "focus", bg: "surface-2", min: 3, note: "focus ring on raised" },
	{ fg: "focus", bg: "brand-subtle", min: 3, note: "focus ring on selected nav item" },
	{ fg: "brand", bg: "surface-1", min: 3, note: "primary fill / switch / checkbox edge on card" },
	{ fg: "brand-fg", bg: "brand", min: 7, note: "primary label (AAA)" },
	{ fg: "ink-2", bg: "surface-3", min: 4.5, note: "secondary on strongest surface" },
	{ fg: "success", bg: "surface-0", min: 4.5, note: "pass text on page" },
	{ fg: "warning", bg: "surface-0", min: 4.5, note: "warn text on page" },
	{ fg: "danger", bg: "surface-0", min: 4.5, note: "fail text on page" },
	{ fg: "danger", bg: "surface-2", min: 4.5, note: "fail text on raised" },
];

/**
 * Pairs that FAIL AA with the website's token values, so components avoid them:
 * - ink-3 on surface-2 is 4.34:1 in light mode → use ink-2 on raised surfaces.
 * - success and warning on surface-2 are 4.47:1 in light mode → put status text on surface-1 or a *-subtle tint, not on raised surfaces.
 * - accent-fg is navy in both modes → use it only on the --accent fill, never on --accent-subtle in dark.
 */
export const forbiddenPairs: ReadonlyArray<{ fg: ColorToken; bg: ColorToken; mode: "light" | "dark" }> = [
	{ fg: "ink-3", bg: "surface-2", mode: "light" },
	{ fg: "accent-fg", bg: "accent-subtle", mode: "dark" },
	{ fg: "success", bg: "surface-2", mode: "light" },
	{ fg: "warning", bg: "surface-2", mode: "light" },
];
