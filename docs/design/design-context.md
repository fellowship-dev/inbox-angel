# .impeccable.md — Design Context for Inbox Angel

Derived from `BRIEF.md` and the logos in `frontend/public/brand/` (no interview: answers came from the BRIEF).

## Design Context

### Users
Small software teams: SaaS founders, indie hackers, vibe-coded apps that moved to their own domain. They arrive stressed and technical-enough: a signup, login or receipt email is bouncing (`550 5.7.26`) or landing in spam, often after a search for the exact error. Secondary: Shopify store owners (order emails in spam), freelancers fixing a client domain. They want one thing: make it stop, and prove it is really fixed. They are skeptical of DMARC vendors and fake social proof.

### Brand Personality
**Calm · Competent · Honest** (friendly, technical when needed).
Voice names the email, not the protocol: "signup emails", "password reset", then SPF/DKIM/DMARC. Never promises inbox placement; draws the line between authentication (fixable this week, guaranteed) and reputation (takes weeks). No invented proof: no user counts, customer logos, badges or testimonials.

### Aesthetic Direction
- **References**: resend.com (clarity), plausible.io (honest open-source SaaS), linear.app (polish).
- **Palette**: sky blue `#60A5FA` is the brand fill. Because white on `#60A5FA` fails AA, buttons use the brand fill with deep-navy text, and links/text accents use a darker blue (`--brand-ink`). Warm halo gold `#FAD172` and blush `#FCA0A4` come straight from the logo and are used sparingly (highlights, the guarantee, small marks). Neutrals are cool slate with a faint blue cast, not warm zinc.
- **Typography**: Geist Sans for UI and prose; Geist Mono for DNS records, error codes and anything copy-pasteable. DNS/records are first-class UI: monospace blocks with a copy button.
- **Shape and motion**: soft radii, thin hairlines, little shadow; light mode default with full dark mode; motion is subtle and honors `prefers-reduced-motion`.
- **Mark**: the kawaii envelope-with-halo (`inboxangel-kawaii-simple.svg`) in the header; used as an accent, never as decoration spam.
- **Anti-references**: NOT enterprise-security (shields, padlocks, SOC 2 badge walls, dark-navy fear marketing), NOT a hype landing page (counters, "trusted by", gradients), NOT cutesy to the point of undermining competence.

### Design Principles
1. **Outcome before protocol**: lead with the email that is failing and the fixed result; the acronym comes second.
2. **Show the evidence, never fake it**: real DNS lookups, real records, real before/after. Where proof does not exist yet, say nothing rather than invent it.
3. **Honest limits are a feature**: state what is guaranteed (authentication) and what is not (inbox placement) next to every CTA.
4. **Records are content**: monospace, copyable, annotated. Technical pages should be usable without leaving the page.
5. **Quiet confidence**: generous space, one primary action per section, repeated at top, middle and bottom of the home page.

### Token System
Defined in `frontend/app/globals.css`:
- `--surface-0/1/2/3` — page, card, raised, strong-line surfaces
- `--ink-1/2/3` — primary, secondary, subtle text
- `--brand` (`#60A5FA`) — fills; `--brand-fg` — text on brand fill (navy); `--brand-ink` — brand-coloured text and links on surfaces; `--brand-subtle` — tints
- `--accent` (`#FAD172`) / `--blush` (`#FCA0A4`) — logo-derived highlights
- `--line`, `--line-strong` — borders
- `--success`, `--warning`, `--danger` — semantic states for checker results

### WCAG
Target WCAG AA. Text/background pairs meet 4.5:1 (3:1 for large text and UI borders). Visible focus ring on every interactive element. Checker results never rely on colour alone (icon + label).
