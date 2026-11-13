---
version: 1
slug: "src"
primary_target: "src"
related_targets: []
---

# Surface brief: dashboard (web/)

**Mode: Operate**

- **Scope:** the whole authenticated dashboard SPA in `web/` (overview, domains, reports, analytics, wizards, settings, audit, members), built on `packages/ui`. Auth screens and the public free-check page share the same system.
- **Job and audience:** the owner, admin or member of a workspace who monitors and fixes email authentication for their domains and needs to know where things are before anything else. They are the website's audience, arriving here as the next step after registering from the site (PRODUCT.md, Users).
- **Task:** see sender evidence, DNS state and policy readiness; copy or apply the right DNS record; change policy only after prerequisites are shown.
- **Constraints:** shell, navigation and controls stay familiar; ambition shows as precision and restraint. Identity is the incumbent design system (DESIGN.md); do not replace it.
- **Open decisions:** signature move, Creative North Star, and any dashboard-specific density or breakpoint rules. None are decided; do not invent them.
