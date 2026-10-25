// Design values the report HTML uses, copied from packages/ui/src/styles/tokens.css (KTD5): the ui package needs a
// build and React, the report must render in the worker and plain Node. test/tokens.test.ts fails if they drift.

export type TokenSet = Readonly<Record<string, string>>;

export const REPORT_TOKENS: { light: TokenSet; dark: TokenSet } = {
  light: {
    'surface-0': '#f7f8fa', 'surface-1': '#ffffff', 'surface-2': '#eff2f6',
    'ink-1': '#0b1f3a', 'ink-2': '#526175', 'ink-3': '#5d6d82',
    brand: '#0b1f3a', 'brand-ink': '#0b1f3a', 'brand-subtle': '#e8eef5', 'brand-fg': '#ffffff',
    accent: '#fad172', 'accent-fg': '#0b1f3a', 'accent-subtle': '#fef7e3',
    success: '#147a3a', 'success-subtle': '#ecfdf3', warning: '#aa4f08', 'warning-subtle': '#fff7e6', danger: '#b91c1c', 'danger-subtle': '#fef2f2',
    line: '#d7dfe8', 'line-strong': '#b8c5d4', focus: '#0b1f3a',
  },
  dark: {
    'surface-0': '#0b1220', 'surface-1': '#142238', 'surface-2': '#1c2e47',
    'ink-1': '#f4f7fb', 'ink-2': '#a8b5c7', 'ink-3': '#8a9bb1',
    brand: '#fad172', 'brand-ink': '#fad172', 'brand-subtle': '#332c1d', 'brand-fg': '#0b1f3a',
    accent: '#fad172', 'accent-fg': '#0b1f3a', 'accent-subtle': '#2a2210',
    success: '#4ade80', 'success-subtle': '#0f2a1a', warning: '#fbbf24', 'warning-subtle': '#2a2110', danger: '#f87171', 'danger-subtle': '#2c1416',
    line: '#33465f', 'line-strong': '#50647e', focus: '#fad172',
  },
};

const vars = (t: TokenSet) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';');

/** Light by default, dark on prefers-color-scheme, `data-theme` forces either: the same selection rules as tokens.css. */
export function tokenCss(): string {
  return `:root{color-scheme:light;${vars(REPORT_TOKENS.light)}}`
    + `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${vars(REPORT_TOKENS.dark)}}}`
    + `:root[data-theme="dark"]{color-scheme:dark;${vars(REPORT_TOKENS.dark)}}`;
}

/** `--name: value;` declarations inside the first block whose selector matches. */
function block(css: string, selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error(`tokens.css block not found: ${selector}`);
  const start = css.indexOf('{', m.index) + 1;
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const d of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim().toLowerCase();
  return out;
}

/** One line per copied value that differs from tokens.css (empty when in sync). Dark falls back to light where tokens.css does not override. */
export function tokenDrift(tokensCss: string): string[] {
  const light = block(tokensCss, /^:root,\s*\[data-theme="light"\]\s*\{/m);
  const darkMedia = block(tokensCss, /:root:not\(\[data-theme="light"\]\)\s*\{/);
  const darkForced = block(tokensCss, /^\[data-theme="dark"\]\s*\{/m);
  const out: string[] = [];
  for (const [k, v] of Object.entries(REPORT_TOKENS.light)) if (light[k] !== v) out.push(`light --${k}: report ${v}, tokens.css ${light[k]}`);
  for (const [label, dark] of [['prefers-color-scheme', darkMedia], ['data-theme', darkForced]] as const) {
    for (const [k, v] of Object.entries(REPORT_TOKENS.dark)) {
      const want = dark[k] ?? light[k];
      if (want !== v) out.push(`dark --${k} (${label}): report ${v}, tokens.css ${want}`);
    }
  }
  return out;
}
