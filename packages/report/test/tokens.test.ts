/// <reference types="node" />
// KTD5: the report's copied design values must match packages/ui/src/styles/tokens.css.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPORT_TOKENS, tokenDrift } from '../src/tokens';

const css = readFileSync(new URL('../../ui/src/styles/tokens.css', import.meta.url), 'utf8');

describe('report tokens vs @inbox-angel/ui tokens.css', () => {
  it('every copied light and dark value equals tokens.css', () => {
    expect(tokenDrift(css)).toEqual([]);
  });

  it('covers the brand, accent, surfaces, ink, lines and semantic colours in both modes', () => {
    for (const k of ['brand', 'brand-fg', 'brand-ink', 'accent', 'accent-fg', 'surface-0', 'surface-1', 'surface-2', 'ink-1', 'ink-2', 'ink-3', 'line', 'line-strong', 'success', 'warning', 'danger', 'focus']) {
      expect(REPORT_TOKENS.light[k], `light ${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const k of ['brand', 'brand-fg', 'surface-0', 'ink-1', 'success', 'warning', 'danger', 'focus']) {
      expect(REPORT_TOKENS.dark[k], `dark ${k}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('changing a colour in tokens.css fails the check (light and dark)', () => {
    const light = css.replace('--brand: #0b1f3a;', '--brand: #60a5fa;');
    expect(light).not.toBe(css);
    expect(tokenDrift(light)).toEqual([expect.stringContaining('light --brand')]);
    const dark = css.replace(/(:root:not\(\[data-theme="light"\]\)\s*\{[^}]*?--danger: )#f87171;/, '$1#ff0000;');
    expect(dark).not.toBe(css);
    expect(tokenDrift(dark)).toEqual([expect.stringContaining('dark --danger')]);
  });
});
