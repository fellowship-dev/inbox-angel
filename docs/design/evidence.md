# Design refinement evidence

Branch `design-system-refinement`. Screenshots are binaries and are **not** committed; they are produced from the gallery with `packages/ui/scripts/evidence.mjs`.

## Reproduce

```
npm run build -w @inbox-angel/ui && npm run build:gallery -w @inbox-angel/ui
npx vite preview --config packages/ui/gallery/vite.config.ts --host 0.0.0.0 --port 8787
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers node packages/ui/scripts/evidence.mjs after /tmp/design-evidence http://127.0.0.1:8787/
```

## Gallery routes (synthetic `.test` fixtures, no customer data)

`/#/signin`, `/#/setup-owner`, `/#/overview-empty`, `/#/overview`, `/#/wizard` (DNS record step), `/#/loading`, `/#/error`, `/#/components`.
Append `?theme=light|dark` and/or `?fixture=long` (before the `#`), e.g. `/?theme=dark&fixture=long#/wizard`.

The script captures each route at 375, 768 and 1440 px (light and dark; long fixture in light) and records, in `checks.json`: document overflow (`scrollWidth <= clientWidth`), axe-core with colour-contrast enabled, unlabeled controls, tab order and outline on sign-in, mobile drawer focus (moves in, trapped, Escape restores), and copy feedback (live region + clipboard) on the DNS record step.

## Verified in the repository (jsdom + token maths)

`npm run test:ui` (render, axe without contrast, token/site-globals parity, per-mode WCAG contrast for every `contrastPairs` entry, dist smoke), `npm run test:web`, `npm run build:dashboard`, `npm run typecheck`, `npm run typecheck -w @inbox-angel/ui`.

## Gaps

The worker sandbox cannot run Chromium (missing system libraries, no root), so browser screenshots, the in-browser axe contrast run and the overflow/keyboard/drawer/copy checks were not executed by the author. The "before" gallery build is preserved at `/tmp/design-evidence/before-gallery` and the "after" gallery is served on port 8787 for host-side capture.

## Integration receipt (rebased onto main 86e308d)

Rebased cleanly (no conflicts) onto `86e308da4881b1866370ab31bc1816ca64576942`; `npm ci` exit 0; manifests and lockfile identical to main. Then: `npm run test:ui` 147 passed (exit 0), `npm run test:web` 294 passed (exit 0), `npm run build:dashboard` exit 0, `npm run typecheck` exit 0, `npm run typecheck -w @inbox-angel/ui` exit 0, `npm run build:gallery -w @inbox-angel/ui` exit 0 with bundle `index-CaA5zCQk.js` / `index-q6fYaaUy.css`, identical to the pre-rebase build.
