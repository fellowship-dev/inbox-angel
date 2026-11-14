// Server-rendered agent pages: OAuth consent, signed out, and form errors. No scripts and no external
// requests apart from the dashboard's own Geist font file; every interpolated value goes through `escape`.
// Colours come from the design-system tokens, so these pages match the dashboard in light and dark mode.
import { darkOverrides, fonts, lightColors, shadows } from '../../packages/ui/src/tokens/tokens';
import type { AccessAction } from '../access/grant';

export const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Plain words for each permission an agent can be given. The raw scope is shown as secondary text. */
export const ACTION_COPY: Readonly<Record<Exclude<AccessAction, 'access:manage'>, { label: string; detail: string }>> = Object.freeze({
 'resources:read': { label: 'See the domains you select', detail: 'Lists the selected domains and the products they belong to.' },
 'reports:read': { label: 'Read email health reports', detail: 'DNS findings, report history, and which evidence is still missing.' },
 'metrics:read': { label: 'Read email statistics', detail: 'Pass rates and volumes from the reports this dashboard has received.' },
 'diagnostics:run': { label: 'Run live DNS checks', detail: 'Looks up the public DNS records of the selected domains. Changes nothing.' },
 'remediation:plan': { label: 'Suggest fixes', detail: 'Writes the DNS changes it recommends, for you to review. It cannot apply them.' },
 'domains:manage': { label: 'Add domains and check ownership', detail: 'Starts monitoring a domain and checks its ownership record. It does not edit DNS or send email.' },
});
/** Pre-selected for a verified client only: the two permissions a first useful answer needs (list the domains, read their report). */
const DEFAULT_ACTIONS: readonly string[] = Object.freeze(['resources:read', 'reports:read']);
export const EXPIRY_CHOICES = [1, 7, 14, 30] as const;
const DEFAULT_EXPIRY = 7;

export interface ConsentModel {
 /** `publisher` is set only for a client whose identity is verified (a Client ID Metadata Document on its own HTTPS domain). */
 client: { name: string; publisher?: string; redirectHost: string; loopback: boolean };
 /** Email of the signed-in person approving. */
 account: string;
 /** Opaque consent handle from the OAuth provider. */
 handle: string;
 workspaces: Array<{ id: string; name: string; choices: Array<{ value: string; domain: string; product?: string }> }>;
 /** Unix seconds, for the stated expiry dates. */
 now: number;
}

const css = (() => {
 const vars = (colors: Record<string, string>) => Object.entries(colors).map(([k, v]) => `--${k}:${v}`).join(';');
 return `@font-face{font-family:"Geist Variable";src:url(/fonts/geist-latin-wght-normal.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
@font-face{font-family:"Geist Mono Variable";src:url(/fonts/geist-mono-latin-wght-normal.woff2) format("woff2");font-weight:100 900;font-style:normal;font-display:swap}
:root{color-scheme:light;${vars(lightColors)};--shadow:${shadows.light.sm}}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;${vars(darkOverrides)};--shadow:${shadows.dark.sm}}}
*{box-sizing:border-box}
body{margin:0;background:var(--surface-0);color:var(--ink-1);font:400 1rem/1.6 ${fonts.sans};-webkit-font-smoothing:antialiased}
.wrap{max-width:40rem;margin:0 auto;padding:40px 16px 64px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:-0.01em;margin-bottom:24px;color:var(--ink-1)}
.brand svg{width:32px;height:32px;border-radius:6px;flex:none}
.card{background:var(--surface-1);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:24px;overflow-wrap:anywhere}
h1{font-size:1.5rem;line-height:1.25;font-weight:600;letter-spacing:-0.025em;margin:0 0 8px}
h2{font-size:1rem;font-weight:600;margin:0}
p{margin:8px 0}
.muted{color:var(--ink-2)}
.small{font-size:.875rem}
.mono,code{font-family:${fonts.mono};font-size:.8125rem}
.facts{margin:16px 0 0;padding:0;list-style:none;border-top:1px solid var(--line)}
.facts li{padding:10px 0;border-bottom:1px solid var(--line);font-size:.875rem}
.facts strong{font-weight:600}
.notice{margin-top:16px;padding:12px 16px;border-radius:10px;background:var(--warning-subtle);border:1px solid var(--warning);color:var(--ink-1);font-size:.875rem}
.never{margin-top:24px;padding:16px;border-radius:14px;background:var(--surface-2);font-size:.875rem}
.never h2{font-size:.875rem;margin-bottom:4px}
.never ul{margin:4px 0 0;padding-left:20px}
.never .last{margin-bottom:0}
h2.sub{font-size:.875rem;font-weight:600;margin:20px 0 0}
fieldset{border:0;margin:28px 0 0;padding:0;min-width:0}
legend{font-size:1rem;font-weight:600;padding:0;margin-bottom:4px}
.group{margin-top:12px}
.group-name{font-size:.75rem;font-weight:600;letter-spacing:.025em;text-transform:uppercase;color:var(--ink-2);margin:0 0 6px}
.option{display:flex;gap:12px;align-items:flex-start;min-height:44px;padding:10px 12px;margin-top:8px;border:1px solid var(--line);border-radius:10px;background:var(--surface-1);cursor:pointer}
.option:hover{background:var(--surface-2)}
.option input{flex:none;width:18px;height:18px;margin:3px 0 0;accent-color:var(--brand)}
.option span{display:block;min-width:0}
.option .detail{color:var(--ink-2);font-size:.875rem}
.option .scope{color:var(--ink-3);font-family:${fonts.mono};font-size:.75rem}
label.field{display:block;margin-top:12px;font-size:.875rem;font-weight:500}
select,input[type=text]{display:block;width:100%;height:40px;margin-top:6px;padding:0 12px;font:inherit;font-size:.875rem;color:var(--ink-1);background:var(--surface-1);border:1px solid var(--control-border);border-radius:10px}
.hint{font-size:.8125rem;color:var(--ink-2);margin-top:4px}
@media (pointer:coarse){select,input[type=text]{height:44px}}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:10px;font:inherit;font-size:.875rem;font-weight:600;cursor:pointer;text-decoration:none}
.primary{background:var(--brand);color:var(--brand-fg);border:1px solid var(--brand)}
.primary:hover{background:var(--brand-hover)}
.secondary{background:var(--surface-1);color:var(--ink-1);border:1px solid var(--line-strong)}
.secondary:hover{background:var(--surface-2)}
a{color:var(--brand-ink);text-underline-offset:4px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.option:focus-within{outline:2px solid var(--focus);outline-offset:2px}
.option input:focus-visible{outline:none}
@media (max-width:480px){.wrap{padding-top:24px}.card{padding:20px}.actions .button{flex:1 1 100%}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;
})();

// LogoMark from packages/ui/src/components/logo.tsx (same geometry); decorative beside the product name.
const LOGO = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><rect width="100" height="100" fill="#0b1f3a"/><ellipse cx="50" cy="23" rx="19" ry="5.5" fill="none" stroke="#fad172" stroke-width="4.5"/><rect x="20" y="38" width="60" height="40" rx="5" fill="#fad172"/><path d="M24 42 50 61 76 42" fill="none" stroke="#0b1f3a" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Security headers for every page rendered here: no scripts, no framing, styles and the font from this origin only, no Referer to other sites. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";
export function pageHeaders(base?: HeadersInit): Headers {
 const headers = new Headers(base);
 headers.set('Content-Type', 'text/html; charset=utf-8');
 headers.set('Cache-Control', 'no-store');
 headers.set('Content-Security-Policy', PAGE_CSP);
 headers.set('X-Content-Type-Options', 'nosniff');
 headers.set('X-Frame-Options', 'DENY');
 // same-origin, not no-referrer: under no-referrer a browser sends `Origin: null` on the consent form's own POST, and the
 // strict same-origin check refuses it (connections.ts). same-origin keeps the real Origin on that POST while still sending
 // nothing to any other site: the redirect to the app, and anything the page links to, get no Referer.
 headers.set('Referrer-Policy', 'same-origin');
 return headers;
}

/** The page shell. `title` and `body` are trusted markup built by this module; escape anything else before passing it. */
export function agentPage(title: string, body: string): string {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Ready Set Mail</title><style>${css}</style></head><body><div class="wrap"><div class="brand">${LOGO}<span>Ready Set Mail</span></div><main class="card">${body}</main></div></body></html>`;
}

const expiryDate = (now: number, days: number) => new Date((now + days * 86400) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function renderConsentPage(m: ConsentModel): string {
 const client = escape(m.client.name);
 // Only a verified client is named in the heading and gets anything pre-ticked; a self-registered name is a claim.
 const verified = !!m.client.publisher;
 const total = m.workspaces.reduce((n, w) => n + w.choices.length, 0);
 const identity = [
  verified
   ? `<li><strong>Published by</strong> <span class="mono">${escape(m.client.publisher)}</span></li>`
   : `<li><strong>Name it gives</strong> "${client}". <strong>Not verified:</strong> the app chose this name itself, so it may not be who it says.</li>`,
  `<li><strong>Access goes to</strong> <span class="mono">${escape(m.client.redirectHost)}</span>${verified ? '' : '. Allow only if that is the app you are using right now.'}</li>`,
  `<li><strong>You are signed in as</strong> ${escape(m.account)}</li>`,
 ].join('');
 const loopback = m.client.loopback ? '<p class="notice" role="note"><strong>This sends access to an app on your own computer.</strong> Continue only if you started this connection from that app just now.</p>' : '';
 const domains = total === 0
  ? '<p class="muted small">You have no domains yet. Add one below, or add domains in the dashboard first.</p>'
  : m.workspaces.filter(w => w.choices.length).map(w => `<div class="group" role="group" aria-label="${escape(w.name)}"><p class="group-name">${escape(w.name)}</p>${w.choices.map(c => `<label class="option"><input type="checkbox" name="selection" value="${escape(c.value)}"${verified && total === 1 ? ' checked' : ''}><span><span class="mono">${escape(c.domain)}</span>${c.product ? `<span class="detail">Only for ${escape(c.product)}</span>` : ''}</span></label>`).join('')}</div>`).join('');
 const actions = (Object.keys(ACTION_COPY) as Array<keyof typeof ACTION_COPY>).map(a => `<label class="option"><input type="checkbox" name="actions" value="${a}"${verified && DEFAULT_ACTIONS.includes(a) ? ' checked' : ''}><span><span>${escape(ACTION_COPY[a].label)}</span><span class="detail">${escape(ACTION_COPY[a].detail)}</span><span class="scope">${a}</span></span></label>`).join('');
 const expiry = EXPIRY_CHOICES.map(d => `<option value="${d}"${d === DEFAULT_EXPIRY ? ' selected' : ''}>${d === 1 ? '1 day' : `${d} days`}, until ${expiryDate(m.now, d)}</option>`).join('');
 const workspaceOptions = m.workspaces.map(w => `<option value="${escape(w.id)}">${escape(w.name)}</option>`).join('');
 const heading = verified ? `Allow ${client} to work with your domains?` : 'An app is asking to work with your domains';
 return agentPage(verified ? `Allow ${client}?` : 'An app is asking for access', `<h1>${heading}</h1>
<p class="muted">Choose exactly what it may see and do. It gets nothing else, and access ends on the date you pick.</p>
<ul class="facts">${identity}</ul>${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escape(m.handle)}">
<fieldset><legend>Domains</legend><p class="muted small">It can only use the domains you tick.</p>${domains}
<h2 class="sub">Also allow one domain that is not added yet</h2><p class="hint">For an agent that sets up a new domain for you. Leave both empty if you don't need it.</p>
<label class="field">Workspace<select name="workspaceId"><option value="">Choose a workspace</option>${workspaceOptions}</select></label>
<label class="field">Domain<input type="text" name="domain" inputmode="url" autocomplete="off" spellcheck="false" placeholder="example.com"></label>
</fieldset>
<fieldset><legend>What it may do</legend>${actions}</fieldset>
<fieldset><legend>When access ends</legend><label class="field">Access ends<select name="days">${expiry}</select></label><p class="hint">Dates are in UTC. You can revoke access sooner in Settings, under Agents and product access.</p></fieldset>
<div class="never"><h2>It can never do these</h2><ul><li>Change your DNS records</li><li>Tighten your DMARC policy</li><li>Send email or invite people</li><li>Give itself more access</li></ul><p class="muted last">You make those changes yourself, in the dashboard or at your DNS provider.</p></div>
<div class="actions"><button class="button primary" type="submit" name="decision" value="allow">Allow access</button><button class="button secondary" type="submit" name="decision" value="deny" formnovalidate>Don't allow</button></div>
</form>`);
}

/** Shown on /oauth/authorize when nobody (or an unverified hosted account) is signed in. */
export function renderSignedOutPage(reason: 'signed_out' | 'unverified'): string {
 const body = reason === 'unverified'
  ? `<h1>Confirm your email first</h1><p>An app asked to connect to your Ready Set Mail account. Open the confirmation link we emailed you, then start the connection again from the app.</p>`
  : `<h1>Sign in to continue</h1><p>An app asked to connect to your Ready Set Mail account. Sign in to the dashboard in this browser, then come back to this tab and reload it. You will see exactly what the app is asking for before anything is shared.</p>`;
 return agentPage(reason === 'unverified' ? 'Confirm your email' : 'Sign in', `${body}<div class="actions"><a class="button primary" href="/">Open the dashboard</a></div>`);
}

/** A consent form that cannot be accepted as sent. */
export function renderConsentProblem(message: string): string {
 return agentPage('Check your choices', `<h1>Check your choices</h1><p>${escape(message)}</p><p class="muted">Nothing was shared. Use your browser's back button to change your choices, or start the connection again from the app.</p>`);
}
