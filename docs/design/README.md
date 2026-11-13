# Design seed

Inputs for the v2 design system (`packages/ui`), shared by the dashboard and the website (inboxangel.io):

- Root `PRODUCT.md` and `DESIGN.md` (plus `.impeccable/design.json` and the dashboard surface brief in `web/.impeccable/surfaces/`): product context and the visual system for the dashboard, for the vendored Impeccable skill. They carry the brand shared with the website: personality, palette rules (navy `#0B1F3A` brand in light, gold `#FAD172` in dark; `--brand-ink` for text), typography (Geist Sans / Geist Mono), principles and WCAG target.
- `site-globals.css`: the website's current light/dark token set and Tailwind 4 setup (parity snapshot of the website token set; the exact palette and its contrast evidence are documented in `packages/ui/README.md`).
- `brand/`: the Inbox Angel logo marks (simple, and a 3-colour SVG Tiny PS draft for BIMI).
