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
- Components are ESM and expect a bundler (Vite etc.).
- Utilities: `bg-surface-1`, `text-ink-2`, `border-line`, `bg-brand text-brand-fg`, `text-brand-ink`, `shadow-soft|lift|pop|float`, `font-mono`.

## Rules baked in

- Brand sky `#60a5fa` is a fill with navy text (`brand-fg`); brand-coloured text uses `brand-ink`.
- Status never relies on colour: icon + word (CheckResult, LevelCard findings, StatusDot label, Alert).
- "Lookup failed" (`error`) is distinct from "Not found" (`missing`) in CheckResult.
- Pairs that fail AA with the website tokens are listed in `forbiddenPairs` (tokens.ts) and avoided:
  `ink-3` on `surface-2` (4.34:1, light) and `accent-fg` on `accent-subtle` (dark). Form controls use the added
  `--control-border` token because `--line-strong` is ~1.5:1 on white (WCAG 1.4.11 needs 3:1).

## Scripts

```
npm run build          # tsc → dist/ (+ CSS)
npm test               # vitest: render, axe, token sync, contrast
npm run dev:gallery    # gallery on http://127.0.0.1:5199
npm run build:gallery
npm run screenshots    # needs Chromium: PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium
```

`gallery/screenshots/` holds the latest light/dark × desktop/375px captures.
