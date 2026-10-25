# @inbox-angel/ui

Design system for Inbox Angel (dashboard and website): tokens, a Tailwind 4 theme and React 19 components.
Token values come from `docs/design/site-globals.css`; `test/tokens.test.ts` fails if they drift.

## Use

```css
/* app.css */
@import "tailwindcss";
@import "@inbox-angel/ui/styles.css"; /* tokens (light/dark), @theme, base styles, bundled Geist fonts, @source for the components */
```

```tsx
import { Button, LevelCard, RecordBlock } from "@inbox-angel/ui";
import { colors } from "@inbox-angel/ui/tokens"; // JS consumers
```

- Light by default, follows `prefers-color-scheme`. Force a theme with `data-theme="light|dark"` on `<html>` or any wrapper.
- Fonts (Geist Sans / Geist Mono, OFL-1.1) ship through `@fontsource-variable/*`: no CDN at runtime.
- Components are ESM (`.js` specifiers, loadable in Node). Interactive ones carry `"use client"`; for React Server Components import pure pieces (Badge, Card, StatusDot, LevelCard, Alert, Table, Stat, tokens …) from `@inbox-angel/ui/server`.
- Utilities: `bg-surface-1`, `text-ink-2`, `border-line`, `bg-brand text-brand-fg`, `text-brand-ink`, `shadow-soft|lift|pop|float`, `font-mono`.

## Rules baked in

- Brand is sober: navy `#0b1f3a` in light mode, halo gold `#fad172` in dark mode. `brand` is a FILL with `brand-fg` labels (white on navy, navy on gold); brand-coloured text and links use `brand-ink`. No sky blue, gradients or mascot faces.
- Status never relies on colour: icon + word (CheckResult, LevelCard findings, StatusDot label, Alert).
- "Lookup failed" (`error`) is distinct from "Not found" (`missing`) in CheckResult.
- Pairs that fail AA with the website tokens are listed in `forbiddenPairs` (tokens.ts) and avoided:
  `accent-fg` on `accent-subtle` (dark). Form controls use the added
  `--control-border` token because `--line-strong` is ~1.5:1 on white (WCAG 1.4.11 needs 3:1).

## Foundations

### Palette (exact values; `tokens.css` is the source, `tokens.ts` and `docs/design/site-globals.css` mirror it)

| Token | Light | Dark |
| --- | --- | --- |
| surface-0 / 1 / 2 / 3 | #F7F8FA / #FFFFFF / #EFF2F6 / #E3E9F0 | #0B1220 / #142238 / #1C2E47 / #293D58 |
| ink-1 / 2 / 3 | #0B1F3A / #526175 / #5D6D82 | #F4F7FB / #A8B5C7 / #8A9BB1 |
| brand = brand-ink | #0B1F3A | #FAD172 |
| brand-hover / brand-fg / brand-subtle | #173A63 / #FFFFFF / #E8EEF5 | #FFE09A / #0B1F3A / #332C1D |
| line / line-strong | #D7DFE8 / #B8C5D4 | #33465F / #50647E |
| control-border (form edges, 3:1) | #617185 | #8A9BB1 |
| focus (ring) | #0B1F3A | #FAD172 |
| accent / accent-fg | #FAD172 / #0B1F3A | #FAD172 / #0B1F3A |
| blush | #FCA0A4 | #FCA0A4 (decorative only: never text, never the sole signal) |

Contrast evidence lives in `contrastPairs` (checked per mode in `test/tokens.test.ts`): body/secondary text ≥ 4.5:1 on every surface, brand-fg on brand ≥ 7:1, focus and control edges ≥ 3:1. No value was adjusted away from the specified palette.

### Semantic status

Status always pairs colour with an icon and a word (Alert, CheckResult, StatusDot, LevelCard).

| Status | Text/icon (light / dark) | Tint (light / dark) | Use |
| --- | --- | --- | --- |
| success | #147A3A / #4ADE80 | #ECFDF3 / #0F2A1A | check passed, verified |
| warning | #AA4F08 / #FBBF24 | #FFF7E6 / #2A2110 | works but needs attention (e.g. DMARC `p=none`) |
| danger | #B91C1C / #F87171 | #FEF2F2 / #2C1416 | failed, blocked, destructive |
| info | brand-ink | brand-subtle | neutral notice, sample data |

Light success/warning were darkened from #15803D/#B45309 so status text meets 4.5:1 on every surface including `surface-2` (4.82:1 / 4.90:1); dark values are unchanged.

### Typography, spacing, radius, motion

- Type: Geist Sans for UI, Geist Mono for DNS records, addresses and codes. Scale: page title `text-2xl sm:text-3xl` semibold, section `text-lg` semibold, card title `text-lg` semibold, body `text-sm`/`text-base`, caption `text-xs`. Headings use `tracking-tight`, `text-balance` and `overflow-wrap:anywhere` so long domains wrap instead of overflowing.
- Spacing: 4px grid. Page sections `space-y-8`; card padding `p-5 sm:p-6`; form fields `space-y-4` with label→control→hint `space-y-2`; one primary action per section.
- Radius: `rounded-md` controls and buttons, `rounded-lg` cards, alerts and record blocks, `rounded-full` pills and icon discs. Shadows stay quiet (`shadow-soft`; `shadow-lift` only for the auth card).
- Motion: 120–220ms ease-out (`ia-fade-in`, `ia-slide-left`, `ia-pop`), colour transitions only on hover. `prefers-reduced-motion` removes all animation and transitions (base.css).
- Focus: 2px `--focus` outline with offset on every interactive element; never remove it. Selected navigation uses `aria-current="page"` plus tint, weight and a 2px marker, not colour alone.

### Logo

`LogoMark` is the website's halo-envelope: `viewBox="0 0 100 100"`, navy square, gold halo ellipse (cx50 cy23 rx19 ry5.5, stroke 4.5), gold envelope rect (x20 y38 60×40 rx5) with a navy flap path. Square: size with `size-8`; add `rounded-md` for a softer tile. It is self-coloured and identical in both themes.

### Shared screens

`AuthLayout` + `Field` (sign-in, owner setup, reset) live here; `web/src/pages/auth/AuthLayout.tsx` re-exports them. Phones get a full-width card starting at the top; from `sm` the card is centred.

## Scripts

```
npm run build          # tsc → dist/ (+ CSS)
npm test               # build, then vitest: render, axe, token sync, contrast, built-dist Node smoke test
npm run dev:gallery    # gallery on http://127.0.0.1:5199
npm run build:gallery
npm run screenshots    # needs Chromium: PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
node scripts/evidence.mjs <label> <outDir> [baseUrl]   # per-route screenshots at 375/768/1440, overflow, axe (with contrast), keyboard, drawer, copy checks
```

Gallery routes (all synthetic `.test` data; add `?fixture=long` for worst-case lengths, `?theme=light|dark`): `#/components`, `#/signin`, `#/setup-owner`, `#/overview-empty`, `#/overview`, `#/wizard` (DNS record step), `#/loading`, `#/error`.

Only the desktop overview and wizard shots (light + dark, WebP) are committed in `gallery/screenshots/`; `npm run screenshots` regenerates all of them locally.
