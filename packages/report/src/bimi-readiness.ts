// BIMI readiness: the steps from where a domain is to its logo in the inbox. Port of unzip-inboxangel outreach-tools/bimi_readiness.py.
//
// BIMI shows the brand's verified logo next to its email in Gmail and Apple Mail. It needs, in this order: DMARC enforced
// for all mail, an SVG logo on HTTPS, a BIMI DNS record, and a certificate (VMC, or CMC where the mailbox provider accepts it).
// Each step is `done`, `todo` or `unknown` (the asset could not be fetched); the first step that is not done is `next`.
// Only presence is checked: the logo's Tiny-PS profile and the certificate chain are not validated here.

import { pctOf, type Facts } from './findings';

export type BimiStepId = 'dmarc-enforced' | 'dmarc-pct' | 'logo' | 'record' | 'certificate';
export type BimiStepState = 'done' | 'todo' | 'unknown';

export interface BimiStep {
  id: BimiStepId;
  title: string;
  state: BimiStepState;
  now: string;
  why: string;
}

export interface BimiReadiness {
  ready: boolean;
  steps: BimiStep[];
  next: BimiStepId | null;
  summary: string;
}

export function bimiSteps(facts: Facts): BimiStep[] {
  const d = facts.dmarc, bimi = facts.bimi;
  const policy = (d.policy ?? '').toLowerCase();
  const sp = (d.sp || policy).toLowerCase();
  const enforcing = (x: string) => x === 'quarantine' || x === 'reject';
  const enforced = d.status === 'found' && d.valid !== false && enforcing(policy) && enforcing(sp);
  const pct = pctOf(d.pct);
  const found = bimi.status === 'found';
  const logo = bimi.logo.status, cert = bimi.certificate.status;
  const st = (ok: boolean, unknown = false): BimiStepState => (unknown ? 'unknown' : ok ? 'done' : 'todo');

  const nowPolicy = d.status === 'found' && policy && sp !== policy ? `p=${policy}, sp=${sp}`
    : d.status === 'found' && policy ? `p=${policy}`
    : d.status === 'none' ? 'no DMARC record' : 'DMARC needs repair first';
  return [
    { id: 'dmarc-enforced', title: 'DMARC enforced on the domain and subdomains (p and sp at quarantine or reject)', state: st(enforced), now: nowPolicy,
      why: 'Providers show a logo only on mail that DMARC protects. This is the longest step: every sender has to pass first.' },
    { id: 'dmarc-pct', title: 'DMARC applies to all of your mail (pct=100)', state: enforced ? st(pct >= 100) : 'todo',
      now: pct >= 100 ? 'pct=100' : `pct=${d.pct}`, why: 'A partial policy does not qualify.' },
    { id: 'logo', title: 'Logo as an SVG on HTTPS', state: st(found && logo === 'present', found && logo === 'unreachable'),
      now: logo === 'present' ? 'reachable SVG' : !found || logo === 'not-declared' ? 'none declared' : `logo ${logo}`, why: 'A square SVG Tiny-PS file at a stable address.' },
    { id: 'record', title: 'BIMI record at default._bimi', state: st(found), now: found ? 'published' : 'not published',
      why: 'One TXT record pointing at the logo and the certificate.' },
    { id: 'certificate', title: 'Certificate (VMC or CMC)', state: st(found && cert === 'present', found && cert === 'unreachable'),
      now: cert === 'present' ? 'reachable PEM' : !found || cert === 'not-declared' ? 'none declared' : `certificate ${cert}`,
      why: "Proves the logo is yours. Gmail needs a VMC (recommended; the checkmark needs it) or a CMC. Apple's BIMI page names a VMC as accepted evidence and does not say a CMC is accepted. Issued by a certificate authority after validation." },
  ];
}

export function bimiReadiness(facts: Facts): BimiReadiness {
  const steps = bimiSteps(facts);
  const todo = steps.filter(s => s.state !== 'done');
  return {
    ready: todo.length === 0, steps, next: todo[0]?.id ?? null,
    summary: todo.length === 0
      ? 'Prerequisites are present (we check that files exist, not that they are valid); whether the logo shows depends on each mailbox provider and on the certificate type.'
      : `${steps.length - todo.length} of ${steps.length} steps done. Next: ${todo[0].title}.`,
  };
}
