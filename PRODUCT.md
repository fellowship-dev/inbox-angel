# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Dashboard users are the website's audience (Max, 2026-11-13): the dashboard is the next step after registering from the Inbox Angel website, so the person signing in is the same person who arrived from the site, there to see and fix email authentication for the domains they send from. Copy, defaults and brand continue the website's; the dashboard does not address a separate operator audience. **Decision (Max, November 13, 2026): a website registrant lands in hosted self-serve** (`MODE=saas`). The hosted registrant is the primary user: the owner of one domain, or an agency or freelancer looking after several client domains (one workspace per client, clients invited as read-only members). A person is available by booking: "Talk to Max" (the `BOOKING_URL` link) is on every hosted screen and at every stuck moment, and paid work is that person doing it.

Self-hosting on one's own Cloudflare account remains a secondary route to the same dashboard (README).

Roles are per workspace (README, Authentication): **owners** and **admins** perform domain operations; **members** read and see every screen with write controls disabled (`web/PARITY.md`). Product credentials and agent connections are managed by a browser owner in Settings. Interactive agents (MCP) act for a signed-in person under finite, consented grants.

## Product Purpose
InboxAngel is a self-hostable email authentication platform. It collects DMARC aggregate reports from receiving mail servers, parses them in a Cloudflare Worker, stores them in D1 and shows trends, failing sources, pass rates and policy guidance in the dashboard. It also manages SPF (lookup depth, flattening), MTA-STS provisioning and TLS-RPT reporting, and a five-step domain setup wizard (Domain, SPF, DKIM, DMARC, Routing).

The stated core value is getting an owner "from 'I don't know' to `p=reject` without breaking your email". Success is a domain whose legitimate senders are all authenticated before enforcement is tightened.

## Positioning
Hosted: sign up, prove you own a domain and see from live DNS where it stands and what to fix, with a named person one click away. Self-hosted: runs entirely on the operator's own Cloudflare account (Workers, Email Workers, D1, Cloudflare DNS API); open source, MIT licensed. Auth is Better Auth on D1. No Fellowship account, Google connection or outbound mail service is needed for a first live-DNS health report.

## Operating Context
- Hosted (primary): sign-up, email verification, domain ownership proof (a DNS TXT record), then live DNS checks, levels and records to copy. DMARC report intake is not connected yet, so every report view says "Reports not connected yet" and nothing that needs reports (pass rates, failing senders, readiness to enforce) is claimed. The setup wizard's fifth step is "Reports" instead of "Routing".
- Self-hosted deployment (one-click Deploy to Cloudflare, CLI, or manual GitHub Actions), then first-owner setup with an installer-held proof. The installer proof is self-host only: the hosted service never asks for one.
- Self-host: reports arrive by email at `rua@reports.<domain>`; arrival timing and coverage vary, so the dashboard states source windows and missing evidence.
- DNS records are added at Cloudflare (applied with one click) or at an external DNS provider (the dashboard shows the record to copy).
- One login may belong to several workspaces, each with its own domains, reports, members and roles.
- Agents connect through the installation's HTTPS `/mcp` endpoint with browser sign-in and exact resource/action/expiry consent; the dashboard lists and revokes them.
- Hash routes (`#/domains/1`) are kept so reset and invite emails and bookmarks keep working (`web/PARITY.md`).

## Capabilities and Constraints
- DMARC monitoring: 30/60-day trends, failing sources, pass rate, observed alignment, coverage and readiness.
- SPF management, MTA-STS with a graduation prompt from `testing` to `enforce`, TLS-RPT success/failure counts.
- Free email check, leads, audit log, members, workspaces, product credentials and Google Postmaster metrics (owner-approved).
- A pass rate alone does not prove every legitimate sender is covered; the UI shows prerequisites before proposing an enforcement change.
- "Lookup failed" is never shown as "Not found".
- Light and dark themes (follows the OS, toggle persisted), mobile layout checked at 375px.
- Hosted mode (`MODE=saas`) is the registrant's route (decided November 13, 2026). What it covers today: live DNS checks, levels, fix guidance and records to copy, for one domain or many (one workspace per client). Not connected yet: DMARC report intake, the free email check and alert mail.

## Brand Commitments
Shared with the Inbox Angel website (inboxangel.io): the name; the personality **Calm · Competent · Honest** (friendly, technical when needed); the palette roles (navy `#0B1F3A`, halo gold `#FAD172`, blush `#FCA0A4`; see DESIGN.md); Geist Sans and Geist Mono; the halo-envelope `LogoMark`; WCAG AA.

- The voice names the email, not the protocol ("signup emails", "password reset"), then SPF/DKIM/DMARC.
- Never promises inbox placement; separates authentication (fixable, verifiable) from reputation (takes weeks).
- No invented proof: no user counts, customer logos, badges or testimonials.
- Not an enterprise-security look (shields, padlocks, SOC 2 badge walls, fear marketing), not a hype landing page, not cutesy to the point of undermining competence.
- No gradients, anywhere, on the dashboard or the website (Max, 2026-11-13). A hard rule; see The No-Gradients Rule in DESIGN.md.
- Reference products named in the repo: resend.com (clarity), plausible.io (honest open-source SaaS), linear.app (polish).

## Evidence on Hand
- Real DNS lookups and received reports inside a running installation; the repository itself ships none.
- Design-system gallery fixtures use synthetic `.test` domains and are labelled as such (`packages/ui/README.md`, `docs/design/evidence.md`).
- Browser screenshots, in-browser axe contrast and overflow/keyboard checks were not executed by the original design author (`docs/design/evidence.md`, Gaps).
- No customer logos, testimonials, user counts, pricing or benchmarks exist in the repository. Future work must not fabricate them.

## Product Principles
Carried over from the shared brand context:
1. **Outcome before protocol:** lead with the email that is failing or the fixed result; the acronym comes second.
2. **Show the evidence, never fake it:** real DNS lookups, real records; where proof does not exist yet, say nothing rather than invent it.
3. **Honest limits are a feature:** state what is guaranteed (authentication) and what is not (inbox placement).
4. **Records are content:** monospace, copyable, annotated; technical pages usable without leaving the page.
5. **Quiet confidence:** generous space, one primary action per section.
6. **No dead ends:** every stuck moment (a failed lookup, a refused step, a limit reached, a domain claimed elsewhere) offers "Talk to Max". When no booking link is configured the link is absent, never disabled or "coming soon".

## Accessibility & Inclusion
WCAG AA: text/background pairs at 4.5:1 (3:1 for large text and UI borders), a visible focus ring on every interactive element, and status that never relies on colour alone (icon + word). `prefers-reduced-motion` removes all animation. Contrast pairs are tested per mode in `packages/ui/test/tokens.test.ts`.

## Open questions
Not resolved here; each needs a product owner's answer.

1. **Success measures.** No success metric is recorded beyond reaching `p=reject` safely.
2. **Positioning claim.** What can a neighbouring DMARC product (hosted or self-hosted) not truthfully copy? Only "runs on your own Cloudflare account, MIT" is evidenced.
3. **Voice details.** Voice rules come from the shared brand context; no dashboard-specific copy guide exists.
4. ~~Where does a website registrant land?~~ Resolved by Max on November 13, 2026: in hosted self-serve, with a person available by booking (see Users).
