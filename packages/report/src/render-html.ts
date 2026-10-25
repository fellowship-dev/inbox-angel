// The HTML report: section order of unzip-inboxangel outreach-tools/render_report.py (biggest problem, also broken,
// possible, not confirmed, lower, BIMI, step by step, caller blocks, unchecked, sources), in the design system's values.
//
// Self-contained: fonts and the mark are embedded, one inline stylesheet and one inline script (copy buttons), a CSP that
// forbids every network fetch, `noindex`, no trackers. The only links are the report URL and the fix sources. Every
// value read from DNS is HTML-escaped. There is no sales block: callers pass their own blocks (trusted HTML).

import { GEIST_MONO_WOFF2 } from './assets/geist-mono';
import { GEIST_SANS_WOFF2 } from './assets/geist-sans';
import type { BimiReadiness } from './bimi-readiness';
import type { FixRecord } from './fixes';
import { MIN_CONFIDENCE, planned, type ReportFinding, type ReportModel } from './model';
import { tokenCss } from './tokens';

export interface CallerBlock {
  id: string;
  /** Trusted HTML from the caller (e.g. the prospecting offer, a DMARC-vendor note). Inserted after the fixes. */
  html: string;
}

export interface RenderHtmlOptions {
  blocks?: CallerBlock[];
}

const E = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Escape, then turn `code` spans into <code> (the only markup catalog text may carry). */
const inline = (text: string) => E(text).replace(/`([^`]+)`/g, '<code>$1</code>');

const SEV: Record<string, [string, string]> = { high: ['▲', 'High'], medium: ['■', 'Medium'], low: ['●', 'Low'] };
const STATE: Record<string, [string, string]> = { done: ['✓', 'Done'], todo: ['○', 'To do'], unknown: ['?', 'Could not check'] };
const tag = (cls: string, [icon, word]: [string, string]) => `<span class="tag ${cls}"><span aria-hidden="true">${icon}</span> ${E(word)}</span>`;

/** The halo-envelope mark (`LogoMark` in @inbox-angel/ui): navy square, gold halo, gold envelope with a navy flap. */
const LOGO = '<svg class="mark" viewBox="0 0 100 100" width="32" height="32" aria-hidden="true">'
  + '<rect width="100" height="100" rx="12" fill="#0b1f3a"/>'
  + '<ellipse cx="50" cy="23" rx="19" ry="5.5" fill="none" stroke="#fad172" stroke-width="4.5"/>'
  + '<rect x="20" y="38" width="60" height="40" rx="5" fill="#fad172"/>'
  + '<path d="M24 42 50 61 76 42" fill="none" stroke="#0b1f3a" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CSS = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--surface-0);color:var(--ink-1);font:16px/1.6 "Geist Variable",system-ui,-apple-system,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem 4rem}
header.top{display:flex;align-items:center;gap:.75rem;padding:1rem 0;border-bottom:1px solid var(--line)}
header.top .mark{flex:none}header.top .brand{font-weight:600;letter-spacing:-.01em;white-space:nowrap}
header.top .dom{margin-left:auto;color:var(--ink-3);font-size:.875rem;overflow-wrap:anywhere;text-align:right}
h1,h2,h3{letter-spacing:-.015em;text-wrap:balance;overflow-wrap:anywhere}
h1{font-size:1.75rem;line-height:1.2;font-weight:600;margin:2rem 0 .75rem}h2{font-size:1.125rem;font-weight:600;margin:2.5rem 0 .75rem}
h3{font-size:1rem;font-weight:600;margin:0 0 .35rem}p{margin:.4rem 0}.muted{color:var(--ink-2)}.small{font-size:.875rem;color:var(--ink-3)}
.card{background:var(--surface-1);border:1px solid var(--line);border-radius:.875rem;padding:1.25rem;margin:.9rem 0;box-shadow:0 1px 2px 0 rgb(15 23 42/.05)}
.card.top{border-color:var(--brand-ink);border-width:2px}.card.unconfirmed{border-style:dashed}
.tags{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 .5rem}
.tag{display:inline-flex;align-items:center;gap:.3rem;font-size:.75rem;font-weight:600;border-radius:9999px;padding:.1rem .6rem;border:1px solid currentColor}
.tag.high{color:var(--danger);background:var(--danger-subtle)}.tag.medium{color:var(--warning);background:var(--warning-subtle)}
.tag.low,.tag.todo{color:var(--ink-2);background:var(--surface-2)}.tag.done,.tag.confirmed{color:var(--success);background:var(--success-subtle)}
.tag.unconfirmed,.tag.unknown{color:var(--warning);background:var(--warning-subtle)}
.rec{position:relative;margin:.6rem 0;border:1px solid var(--line-strong);border-radius:.875rem;background:var(--surface-2);padding:.75rem 1rem}
.rec dl{margin:0;display:grid;grid-template-columns:4.5rem 1fr;gap:.15rem .75rem;font-size:.875rem;padding-right:5rem}.rec dt{color:var(--ink-3)}.rec dd{margin:0;overflow-wrap:anywhere}
code,.mono{font-family:"Geist Mono Variable",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;overflow-wrap:anywhere}
.rec code.val{display:block;white-space:pre-wrap;color:var(--ink-1)}
button.copy{position:absolute;top:.5rem;right:.5rem;font:inherit;font-size:.8rem;font-weight:600;background:var(--brand);color:var(--brand-fg);border:0;border-radius:.375rem;padding:.25rem .6rem;cursor:pointer}
button.copy:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
ol.steps{padding-left:1.25rem;margin:.5rem 0}ol.steps li{margin:.35rem 0}
.ev{margin:.4rem 0;padding-left:.75rem;border-left:3px solid var(--line-strong);font-size:.85rem;color:var(--ink-2);overflow-wrap:anywhere}
details{margin:.6rem 0}summary{cursor:pointer;color:var(--brand-ink);font-weight:600}
a{color:var(--brand-ink)}ul.plain{padding-left:1.1rem}ul.plain li{margin:.25rem 0;overflow-wrap:anywhere}
.fail{font-weight:600;color:var(--warning)}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.85rem;color:var(--ink-3)}
@media (prefers-reduced-motion:no-preference){button.copy{transition:background-color .15s ease-out}}
@media print{button.copy{display:none}body{background:#fff}}
`;

const JS = "document.querySelectorAll('button.copy').forEach(function(b){b.addEventListener('click',function(){var t=b.getAttribute('data-copy');"
  + "if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){b.textContent='Copied'})}else{b.textContent='Select and copy'}})})";

const fontFace = (family: string, b64: string) =>
  `@font-face{font-family:'${family}';font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;

function recBlock(r: FixRecord): string {
  return `<div class="rec"><button class="copy" type="button" data-copy="${E(r.value)}" aria-label="Copy the value of the ${E(r.type)} record for ${E(r.host)}">Copy value</button>`
    + `<dl><dt>Type</dt><dd class="mono">${E(r.type)}</dd><dt>Name</dt><dd class="mono">${E(r.host)} <span class="small">(${E(r.name)})</span></dd>`
    + `<dt>Value</dt><dd><code class="val">${E(r.value)}</code></dd></dl>`
    + (r.note ? `<p class="small">${inline(r.note)}</p>` : '') + '</div>';
}

function findingCard(f: ReportFinding, resolvers: number, top = false): string {
  const fx = f.fix;
  const state = f.status === 'confirmed'
    ? tag('confirmed', ['✓', resolvers > 1 ? `Confirmed by ${f.consensus.produced} of ${resolvers} resolvers` : 'Seen by one resolver'])
    : tag('unconfirmed', ['?', `Unconfirmed: ${f.consensus.produced} of ${resolvers} resolvers saw this`]);
  const ev = f.evidence.slice(0, 5).map(e => `<div class="ev mono">${E(e)}</div>`).join('');
  const body = f.status === 'confirmed' ? `<p>${inline(fx.why || f.recommendation)}</p>`
    : '<p class="muted">The public resolvers disagreed, so this is not stated as fact and has no fix below. Re-check before acting.</p>';
  return `<div class="card${top ? ' top' : ''}${f.status === 'unconfirmed' ? ' unconfirmed' : ''}" id="finding-${E(f.id)}">`
    + `<div class="tags">${tag(E(f.severity), SEV[f.severity])}${state}</div>`
    + `<h3>${E(fx.catalog && f.status === 'confirmed' ? fx.title : f.title)}</h3>${body}${ev}</div>`;
}

function fixBlock(f: ReportFinding): string {
  const fx = f.fix;
  const parts = [`<div class="card" id="fix-${E(f.id)}"><h3>${E(fx.title)}</h3>`];
  if (fx.records.length) {
    parts.push(`<p class="muted">${fx.records.length === 1 ? 'Record to add or change' : 'Records to add or change'}${fx.exact ? ' (exact, built from your current DNS)' : ''}:</p>`);
    parts.push(...fx.records.map(recBlock));
  }
  if (fx.needsFromProvider.length) {
    parts.push(`<p class="small">Your provider generates part of this record: ${E(fx.needsFromProvider.join('; '))}. Copy it from there; we cannot see it from outside.</p>`);
  }
  if (fx.steps.length) parts.push('<ol class="steps">' + fx.steps.map(s => `<li>${inline(s)}</li>`).join('') + '</ol>');
  for (const h of fx.hints) parts.push(`<p class="small">${inline(h)}</p>`);
  if (fx.optionalNext) parts.push(`<p>${inline(fx.optionalNext)}</p>`);
  if (fx.caveat) parts.push(`<p class="small">${inline(fx.caveat)}</p>`);
  parts.push('</div>');
  return parts.join('');
}

function bimiBlock(r: BimiReadiness): string {
  const rows = r.steps.map(x => `<li>${tag(x.state, STATE[x.state])} <strong>${E(x.title)}</strong><br><span class="small">Now: ${E(x.now)}. ${E(x.why)}</span></li>`).join('');
  return `<h2>BIMI readiness: your logo in the inbox</h2><p class="muted">BIMI shows your verified logo next to your emails in Gmail and Apple Mail. ${E(r.summary)}</p>`
    + `<div class="card"><ol class="steps">${rows}</ol></div>`;
}

function stackLine(m: ReportModel): string {
  const names = [...new Set([...m.providers.mailbox, ...m.providers.sender].map(p => p.name))];
  const dns = m.dnsHost.id === 'unknown' ? 'DNS host not recognised' : `DNS hosted at ${m.dnsHost.label}`;
  return (names.join(', ') || 'no mail service recognised from public DNS') + ' · ' + dns;
}

export function renderHtml(m: ReportModel, { blocks = [] }: RenderHtmlOptions = {}): string {
  const d = m.domain;
  const confirmed = m.findings.filter(f => f.status === 'confirmed');
  const unconfirmed = m.findings.filter(f => f.status === 'unconfirmed');
  const possible = confirmed.filter(f => f.confidence < MIN_CONFIDENCE); // hints, not findings: not counted or headlined
  const sure = confirmed.filter(f => f.confidence >= MIN_CONFIDENCE);
  const main = sure.filter(f => f.severity === 'high' || f.severity === 'medium');
  const low = sure.filter(f => f.severity === 'low');
  const fixable = confirmed.filter(planned);
  const card = (f: ReportFinding, top = false) => findingCard(f, m.resolvers, top);

  const n = main.length;
  const head = n ? `${d} has ${n} email-authentication problem${n === 1 ? '' : 's'} that can send marketing and order emails to spam`
    : `No serious email-authentication problems found on ${d}`;
  const cross = m.resolvers > 1
    ? ` Each lookup was run against ${m.resolvers} public DNS resolvers; a finding is confirmed when at least two saw it and none disagreed.` : '';
  const body = [`<h1>${E(head)}</h1>`, `<p class="muted">Checked from public DNS on ${E(m.generatedAt.slice(0, 10))}. Stack we could see: ${E(stackLine(m))}.${E(cross)}</p>`];
  if (main.length) body.push(`<h2>The biggest problem</h2>${card(main[0], true)}`);
  if (main.length > 1) body.push('<h2>Also broken</h2>' + main.slice(1).map(f => card(f)).join(''));
  if (possible.length) body.push('<h2>Possible issues (check by hand)</h2><p class="muted">We could not confirm these from outside, so they are not counted above.</p>' + possible.map(f => card(f)).join(''));
  if (unconfirmed.length) body.push('<h2>Not confirmed</h2><p class="muted">The public resolvers gave different answers for these. They are not counted, and no fix is suggested until a re-check agrees.</p>' + unconfirmed.map(f => card(f)).join(''));
  if (low.length) body.push('<h2>Worth knowing, lower priority</h2>' + low.map(f => card(f)).join(''));
  if (m.bimi) body.push(bimiBlock(m.bimi));
  if (fixable.length) {
    const intro = m.dnsHost.id === 'cloudflare' ? 'Your DNS is on Cloudflare, so the steps below are written for its dashboard.'
      : 'The steps below are written for any DNS host; Cloudflare-specific steps appear when we can see Cloudflare nameservers.';
    body.push(`<h2>The fixes, step by step</h2><p class="muted">${E(intro)}</p>` + fixable.map(fixBlock).join(''));
  }
  body.push(...blocks.map(b => b.html));
  const failedChecks = new Set(m.lookupFailed.map(x => `${x.check}: `));
  const rest = m.unchecked.filter(u => ![...failedChecks].some(p => u.startsWith(p)));
  body.push('<h2>What we could not check</h2><ul class="plain">'
    + m.lookupFailed.map(x => `<li><span class="fail"><span aria-hidden="true">!</span> Lookup failed</span> for ${E(x.check)} (${E(x.message)}). This is not the same as "not found": the record may exist.</li>`).join('')
    + rest.map(u => `<li>${E(u)}</li>`).join('') + '</ul>');
  const sources = [...new Set(fixable.flatMap(f => f.fix.sources))];
  if (sources.length) {
    body.push('<details><summary>Where these instructions come from</summary><ul class="plain">'
      + sources.map(s => `<li><a href="${E(s)}" rel="noopener noreferrer nofollow">${E(s)}</a></li>`).join('') + '</ul></details>');
  }
  const link = m.reportUrl ? ` This report: <a href="${E(m.reportUrl)}" rel="noopener noreferrer">${E(m.reportUrl)}</a>.` : '';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer">'
    + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'\">"
    + `<title>Email check for ${E(d)} · Inbox Angel</title>`
    + `<style>${fontFace('Geist Variable', GEIST_SANS_WOFF2)}${fontFace('Geist Mono Variable', GEIST_MONO_WOFF2)}${tokenCss()}${CSS}</style></head><body><main>`
    + `<header class="top">${LOGO}<span class="brand">Inbox Angel</span><span class="dom">Email check · ${E(d)}</span></header>`
    + body.join('')
    + `<footer>Prepared for ${E(d)} by Inbox Angel. Read from public DNS only; nothing was logged into.${link} `
    + 'This page is private to whoever got the link, is not indexed, and has no trackers or analytics.</footer>'
    + `</main><script>${JS}</script></body></html>`;
}

export const renderJson = (m: ReportModel): string => JSON.stringify(m, null, 2);
