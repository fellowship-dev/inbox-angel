---
name: Ready Set Mail Dashboard
description: Calm, competent, honest operator UI for email authentication, built on @ready-set-mail/ui.
colors:
  navy: "#0B1F3A"
  navy-hover: "#173A63"
  halo-gold: "#FAD172"
  halo-gold-hover: "#F5C04A"
  halo-gold-subtle: "#FEF7E3"
  blush: "#FCA0A4"
  surface-page: "#F7F8FA"
  surface-card: "#FFFFFF"
  surface-raised: "#EFF2F6"
  surface-strong: "#E3E9F0"
  ink-primary: "#0B1F3A"
  ink-secondary: "#526175"
  ink-subtle: "#5D6D82"
  brand-subtle: "#E8EEF5"
  on-brand: "#FFFFFF"
  line: "#D7DFE8"
  line-strong: "#B8C5D4"
  control-border: "#617185"
  success: "#147A3A"
  success-subtle: "#ECFDF3"
  warning: "#AA4F08"
  warning-subtle: "#FFF7E6"
  danger: "#B91C1C"
  danger-subtle: "#FEF2F2"
  dark-surface-page: "#0B1220"
  dark-surface-card: "#142238"
  dark-surface-raised: "#1C2E47"
  dark-surface-strong: "#293D58"
  dark-ink-primary: "#F4F7FB"
  dark-ink-secondary: "#A8B5C7"
  dark-ink-subtle: "#8A9BB1"
  dark-brand: "#FAD172"
  dark-brand-hover: "#FFE09A"
  dark-brand-subtle: "#332C1D"
  dark-on-brand: "#0B1F3A"
  dark-line: "#33465F"
  dark-line-strong: "#50647E"
  dark-control-border: "#8A9BB1"
  dark-success: "#4ADE80"
  dark-warning: "#FBBF24"
  dark-danger: "#F87171"
typography:
  page-title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  card-title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "-0.025em"
  stat-value:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
  body-large:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
  caption:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
  record:
    fontFamily: "Geist Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  "2xl": "24px"
  full: "9999px"
spacing:
  base: "4px"
  field: "16px"
  card-mobile: "20px"
  card: "24px"
  section: "32px"
components:
  button-primary:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.navy-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-raised}"
  button-danger:
    backgroundColor: "{colors.danger-subtle}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 16px"
  card:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.lg}"
    padding: "24px"
  input:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
  badge-success:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  nav-item-current:
    backgroundColor: "{colors.brand-subtle}"
    textColor: "{colors.navy}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
  record-block:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.record}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
---

# Design System: Ready Set Mail Dashboard

## Overview

The dashboard (`web/`) is built on the shared design system `@ready-set-mail/ui` (`packages/ui`), which is also used by the Ready Set Mail website. The brand is shared with the website: the name, the personality **Calm · Competent · Honest** (friendly, technical when needed), the palette roles below, Geist Sans and Geist Mono, the halo-envelope mark, WCAG AA, and no invented proof (no user counts, logos, badges or testimonials). Values here are read from `packages/ui/src/styles/{tokens,theme,base}.css` and the components, not from the website. The dashboard is the next step after registering from the website: the same person arrives from the site, so it continues the same brand rather than introducing a separate product look (Max, 2026-11-13).

Source-stated qualities: sober navy in light mode, halo gold in dark mode, cool slate-navy neutrals, soft radii, thin hairlines, little shadow, subtle motion, light mode by default with a full dark mode. Technical content (DNS records, error codes, addresses) is first-class and set in monospace. Rejected by the source: sky blue as a primary, mascot faces, enterprise-security imagery (shields, padlocks, badge walls), hype-landing devices, and cutesiness that undermines competence. Gradients are banned outright (see The No-Gradients Rule).

Creative North Star, overview mood language and any named metaphor: **open decision** (the repository records none, and none was supplied).

**Key Characteristics:**
- Navy fill (light) or gold fill (dark) for the one primary action per section; everything else is neutral.
- Hairline-bordered cards on a cool-grey page; depth is tonal first, shadow second.
- Status is always icon + word, never colour alone.
- Visible 2px focus ring on every interactive element.

## Colors

A restrained palette: cool neutrals, one brand fill that swaps between navy and gold by theme, and semantic status colours that only appear when they mean something. The light/dark pairs below are the values in `tokens.css`; frontmatter keys prefixed `dark-` are the dark-mode values.

### Primary
- **Sober Navy** (#0B1F3A): the light-mode brand. Primary button fill, links and brand text (`--brand-ink`), headings and body ink, focus ring.
- **Halo Gold** (#FAD172): the dark-mode brand fill (with navy labels, `#0B1F3A`), the dark focus ring and brand text, and the highlight accent in both modes.

### Secondary
- **Blush** (#FCA0A4): decorative accent only. Never text, never the sole signal of anything.

### Neutral
- **Page, Card, Raised, Strong** (light #F7F8FA / #FFFFFF / #EFF2F6 / #E3E9F0; dark #0B1220 / #142238 / #1C2E47 / #293D58): `surface-0..3`.
- **Ink 1 / 2 / 3** (light #0B1F3A / #526175 / #5D6D82; dark #F4F7FB / #A8B5C7 / #8A9BB1): primary, secondary and subtle text.
- **Hairline** (#D7DFE8 light, #33465F dark) and **Strong hairline** (#B8C5D4, #50647E): borders and dividers.
- **Control edge** (#617185 light, #8A9BB1 dark): form-control borders, added because the strong hairline is about 1.5:1 on white and WCAG 1.4.11 needs 3:1.
- **Brand tint** (#E8EEF5 light, #332C1D dark): selected navigation and info surfaces.

### Semantic
- **Success** (#147A3A / #4ADE80), **Warning** (#AA4F08 / #FBBF24, e.g. DMARC `p=none`), **Danger** (#B91C1C / #F87171) with tints (#ECFDF3, #FFF7E6, #FEF2F2 / #0F2A1A, #2A2110, #2C1416). Light success and warning were darkened from #15803D and #B45309 to reach 4.5:1 on every surface. Info uses brand-ink on the brand tint.

### Named Rules
**The Fill-Versus-Ink Rule.** `brand` is a fill and takes `brand-fg` labels (white on navy, navy on gold); brand-coloured text and links use `brand-ink`.
**The Blush Rule.** Blush is decorative only.
**The No-Colour-Alone Rule.** Every status pairs colour with an icon and a word.
**The No-Gradients Rule.** No gradients, anywhere, on the dashboard or the website (Max, 2026-11-13): no gradient fills, text, dividers, borders, loading shimmers or scroll shadows. Every colour is a solid token. This is a hard rule, not a preference; existing gradients in code are known debt to remove, not precedent.

The dashboard has none: skeletons are a solid `surface-3` opacity pulse (`ia-pulse`), and an overflowing table marks the edge that hides columns with a `control-border` hairline plus a "Scroll sideways" label. `packages/ui/test/tokens.test.ts` fails if a gradient appears in `packages/ui/src` or `web/src`.

Known gradient debt (to remove):
- Website (same rule): `frontend/app/globals.css` `.shimmer` and `.section-rule` in fellowship-dev/ready-set-mail-website; the reference snapshot `docs/design/site-globals.css` (lines 354 and 412) copies both and is not shipped.

## Typography

**Sans:** Geist Sans (Geist Variable; fallback `ui-sans-serif, system-ui, -apple-system, sans-serif`) for UI and prose.
**Mono:** Geist Mono (Geist Mono Variable; fallback `ui-monospace, SFMono-Regular, Menlo, monospace`) for DNS records, addresses and codes.

Fonts are bundled through `@fontsource-variable/*`; no CDN at runtime. Body line-height is 1.6 with antialiased smoothing.

### Hierarchy
- **Page title** (600, 1.5rem, 1.875rem from `sm`, leading-tight): `PageHeader` h1; tight tracking, balanced wrapping, `overflow-wrap:anywhere` so long domains wrap.
- **Card / section title** (600, 1.125rem, leading-snug): `CardTitle` and section headings.
- **Stat value** (700, 1.875rem, tabular figures): `Stat`.
- **Body** (400, 0.875rem or 1rem, 1.6): working text; descriptions are `ink-2`, capped at `max-w-prose`.
- **Label** (600, 0.75rem, wide tracking, uppercase): nav section labels and record field names.
- **Caption** (0.75rem): hints and metadata.
- **Record** (Geist Mono, 0.875rem, leading-relaxed): record values.

### Named Rules
**The Records-Are-Content Rule.** Anything copy-pasteable is monospace, selectable and copyable.

## Layout

A 4px spacing grid. Page sections are separated by `space-y-8` (32px); card padding is `p-5` (20px), `sm:p-6` (24px); form fields stack at `space-y-4` with label, control and hint at `space-y-2`; one primary action per section. The shell (`AppShell`) is a sidebar with workspace switcher, grouped navigation and footer, plus a top bar for breadcrumb/domain switcher and theme/account controls. The sidebar can collapse to icons; on phones it becomes a focus-trapped drawer. Auth screens use a centred card from `sm`, full-width from the top on phones. Mobile layout is checked at 375px. Container widths and breakpoints beyond Tailwind defaults: **open decision** (none are defined in `packages/ui`).

## Elevation & Depth

Tonal layering with hairlines first; shadows are quiet and used for floating layers. Depth ladder: page (`surface-0`), card (`surface-1` plus hairline), raised and inset areas (`surface-2`, `surface-3`).

### Shadow Vocabulary
- **Soft** (`--shadow-sm`: `0 1px 2px 0 rgb(15 23 42 / 0.05)`; dark `rgb(0 0 0 / 0.3)`): cards.
- **Lift** (`--shadow-md`): the auth card only.
- **Pop** (`--shadow-lg`): menus and toasts.
- **Float** (`--shadow-xl`): dialogs.

### Named Rules
**The Quiet-Shadow Rule.** Cards carry only the soft shadow; larger shadows are for layers that float over content.

## Shapes

Soft radii, thin 1px hairlines. `rounded-md` (10px) for controls, buttons, nav items and menus; `rounded-lg` (14px) for cards, alerts, tables and record blocks; `rounded-xl` (20px) dialogs; `rounded-full` for badges, pills and icon discs; `rounded-sm` (6px) for inline links and menu items. The logo is a square tile (`rounded-md` optional).

## Components

Character source: `packages/ui/README.md` ("sober", status never by colour alone). Detailed behaviour per the code:

### Buttons
- **Shape:** 10px radius; heights sm 32, md 40, lg 48px; text `sm` (lg is `base`); icons 16px (20px at lg).
- **Primary:** brand fill with `brand-fg` label, hover `brand-hover`.
- **Secondary:** card surface, strong hairline, hover `surface-2`. **Ghost:** transparent, hover `surface-2`. **Danger:** `danger-subtle` fill with danger text and border. **Link:** brand-ink, underline offset 4px.
- **States:** colour transition only; disabled is 50% opacity with no pointer events.

### Cards / Containers
- 14px radius, 1px hairline, card surface, soft shadow. Header and content padding 20px (24px from `sm`); optional footer with top hairline on a half-strength `surface-2`. Card titles are `text-lg` semibold.

### Inputs / Fields
- 40px high, 10px radius, `control-border` edge on the card surface, placeholder `ink-3`, 12px horizontal padding.
- **Invalid:** `aria-invalid` switches to a 2px danger border. **Disabled:** 50% opacity.

### Navigation
- Items 40px high, 10px radius, `text-sm` medium, icons 20px; default `ink-2`, hover `surface-2` with `ink-1`. Current item uses `aria-current="page"`, brand tint, semibold weight and a 2px left marker, never colour alone. Section labels are small uppercase `ink-2`. Collapsed state shows icons with sr-only labels and tooltips. Tabs use a bottom border: 2px `brand-ink` when active.

### Status and badges
- **Badge:** pill, 12px medium text, variants neutral, brand, success, warning, danger, outline; paired with an icon or word.
- **StatusDot:** per-status Lucide icon (check, triangle, x, dashed circle, info) plus label. **Alert:** tinted card with icon and title; danger and warning use `role="alert"`. **CheckResult** distinguishes "Lookup failed" from "Not found". **LevelCard** shows the Delivering, Authenticated and Protected levels with findings.

### DNS Record Block (signature)
- Raised-surface block with 14px radius; each field (Type, Name, Value, optional TTL) is a label/value row in Geist Mono with a copy icon button on Name and Value. Copy feedback is a check icon plus a polite live-region announcement ("Copied to clipboard") and resets after 2 seconds.

### Motion
- `ia-fade-in` 150ms, `ia-pop` 120ms, `ia-scale-in` 200ms and `ia-slide-up` 200ms (`cubic-bezier(0.16, 1, 0.3, 1)`), `ia-slide-left` 220ms. `ia-pulse` 1.5s for skeletons: a solid `surface-3` fill pulsing between full and half opacity, held still under reduced motion. `prefers-reduced-motion` reduces all animation and transitions to 0.01ms.

## Do's and Don'ts

### Do:
- **Do** use the brand fill (`bg-brand text-brand-fg`) for the single primary action of a section and `text-brand-ink` for brand-coloured text.
- **Do** pair every status with an icon and a word.
- **Do** keep the 2px `--focus` outline on every interactive element.
- **Do** show DNS records, addresses and codes in Geist Mono with a copy control.
- **Do** use `control-border` for form edges and keep text pairs at 4.5:1 (3:1 for large text and UI borders).
- **Do** honour `prefers-reduced-motion`.

### Don't:
- **Don't** use sky blue as a primary or a mascot face.
- **Don't** use gradients anywhere: fills, text, dividers, borders, loading shimmers and scroll shadows are solid colours.
- **Don't** use blush for text or as the only signal.
- **Don't** use enterprise-security imagery (shields, padlocks, badge walls) or hype-landing devices (counters, "trusted by").
- **Don't** use `accent-fg` on `accent-subtle` in dark mode (fails AA; listed in `forbiddenPairs`) or `--line-strong` for form-control edges.
- **Don't** invent proof: no user counts, customer logos or testimonials.
