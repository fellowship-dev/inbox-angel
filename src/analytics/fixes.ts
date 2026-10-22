// "What to fix next": a ranked list derived from the sender inventory. Each item names the sender, how much of
// the domain's mail it touches, and the concrete change (SPF include, DKIM setup with the provider's guide).
// Provider facts (SPF include, DKIM selectors, guide URLs) come from the same registry the DNS checks use.

import { extractIncludes, extractOtherMechanisms, existingQualifier, buildSpfRecord } from '@inbox-angel/dns-checks/spf-record';
import { identifySender } from '@inbox-angel/dns-checks/sender-providers';
import { pct, type Sender } from './senders';

export type FixKind = 'authorize-sender' | 'fix-dkim-alignment' | 'investigate-sender' | 'review-new-sender';
export type FixSeverity = 'high' | 'medium' | 'low';

export interface FixRecord {
  type: string;
  name: string;
  value: string;
}

export interface Fix {
  id: string;
  kind: FixKind;
  severity: FixSeverity;
  domain: string;
  domain_id: number;
  sender: { name: string; provider_id: string | null; ips: string[] };
  title: string;
  /** Why it matters, in a sentence or two. */
  detail: string;
  /** Share of the domain's mail this sender sends, and the share that is affected by the problem. */
  share_pct: number;
  affected_pct: number;
  affected_messages: number;
  steps: string[];
  /** Records to add, copyable. Only where the value is the same for every customer. */
  records: FixRecord[];
  guide_url: string | null;
}

export interface FixDomain {
  id: number;
  domain: string;
  spf_record: string | null;
}

/** Below both of these a problem is noise, not a to-do. */
const MIN_AFFECTED_PCT = 0.5;
const MIN_AFFECTED_MESSAGES = 20;
/** A provider whose mail fails DMARC at least this often needs authorizing; below it, ordinary noise (forwarding). */
const AUTHORIZE_AT = 0.05;
/** Aligned DKIM on fewer than this share of a provider's mail means it relies on SPF alone. */
const DKIM_WEAK_BELOW = 0.5;
const SCORE: Readonly<Record<FixKind, number>> = { 'authorize-sender': 3, 'investigate-sender': 2, 'fix-dkim-alignment': 1, 'review-new-sender': 0.2 };

interface Group {
  key: string;
  name: string;
  providerId: string | null;
  senders: Sender[];
  messages: number;
  dmarcFail: number;
  spfAligned: number;
  dkimAligned: number;
  isNew: boolean;
}

function groupSenders(senders: Sender[]): Group[] {
  const by = new Map<string, Group>();
  for (const s of senders) {
    const key = s.provider ? `p:${s.provider.id}` : `ip:${s.source_ip}`;
    const g = by.get(key) ?? { key, name: s.provider?.name ?? senderLabel(s), providerId: s.provider?.id ?? null, senders: [], messages: 0, dmarcFail: 0, spfAligned: 0, dkimAligned: 0, isNew: false };
    g.senders.push(s);
    g.messages += s.messages;
    g.dmarcFail += s.dmarc_fail_messages;
    g.spfAligned += s.spf_aligned_messages;
    g.dkimAligned += s.dkim_aligned_messages;
    g.isNew ||= s.is_new;
    by.set(key, g);
  }
  return [...by.values()];
}

/** "mail.example.net (Example Hosting)" or the bare IP. */
export function senderLabel(s: Pick<Sender, 'source_ip' | 'reverse_dns' | 'org' | 'base_domain'>): string {
  const host = s.reverse_dns || s.base_domain;
  if (host && s.org) return `${host} (${s.org})`;
  return host || s.org || s.source_ip;
}

/** The SPF record with `include` added, keeping its other mechanisms and qualifier; null if we should not guess (redirect=). */
export function spfWithInclude(record: string | null, include: string): string | null {
  if (!record || /(^|\s)redirect=/i.test(record)) return null;
  return buildSpfRecord([...extractIncludes(record), include], existingQualifier(record), extractOtherMechanisms(record));
}

const hasInclude = (record: string | null, include: string): boolean => !!record && extractIncludes(record).some((i) => i.toLowerCase() === include.toLowerCase());
const fmtPct = (n: number): string => `${n >= 10 || Number.isInteger(n) ? Math.round(n) : n}%`;

export function buildFixes(domain: FixDomain, senders: Sender[]): Fix[] {
  const total = senders.reduce((n, s) => n + s.messages, 0);
  if (total === 0) return [];
  const fixes: Fix[] = [];

  for (const g of groupSenders(senders)) {
    const share = pct(g.messages, total);
    const ips = g.senders.map((s) => s.source_ip);
    const sender = { name: g.name, provider_id: g.providerId, ips };
    const base = { domain: domain.domain, domain_id: domain.id, sender, share_pct: share };
    const material = (affected: number) => pct(affected, total) >= MIN_AFFECTED_PCT || affected >= MIN_AFFECTED_MESSAGES;

    const sig = g.senders[0] && identifySender({ ...g.senders[0], spf_domain: g.senders[0].spf_domain, dkim_domain: g.senders[0].dkim_domain });
    const registry = sig?.registry ?? null;
    const include = registry?.include || null;
    const guide = registry?.dkimGuideUrl ?? null;
    const failShare = g.dmarcFail / g.messages;

    if (g.providerId && failShare >= AUTHORIZE_AT && material(g.dmarcFail)) {
      const steps: string[] = [];
      const records: FixRecord[] = [];
      if (include && !hasInclude(domain.spf_record, include)) {
        steps.push(`Add include:${include} to the SPF record of ${domain.domain}${domain.spf_record ? '' : ' (there is none yet: publish one)'}.`);
        const next = spfWithInclude(domain.spf_record, include);
        if (next) records.push({ type: 'TXT', name: domain.domain, value: next });
      } else if (include) {
        steps.push(`SPF already includes ${include}. Check that ${g.name} sends with an envelope domain under ${domain.domain}, or rely on DKIM.`);
      }
      steps.push(`Turn on custom-domain DKIM signing for ${domain.domain} in ${g.name}${guide ? ` (their guide is linked below)` : ''}, and publish the DNS records it gives you.`);
      if (sig?.dkimCname) records.push({ type: 'CNAME', name: `${sig.dkimCname.selector}._domainkey.${domain.domain}`, value: sig.dkimCname.target });
      steps.push('Send a test message, then check the Sender inventory again in a day or two.');
      fixes.push({
        ...base, id: `authorize:${domain.id}:${g.key}`, kind: 'authorize-sender', severity: pct(g.dmarcFail, total) >= 5 ? 'high' : 'medium',
        title: `${g.name} sends ${fmtPct(share)} of your mail and fails DMARC`,
        detail: `${fmtPct(pct(g.dmarcFail, g.messages))} of what ${g.name} sent as ${domain.domain} passed neither SPF nor DKIM aligned with your domain. Once DMARC enforces, receivers will quarantine or reject it.`,
        affected_pct: pct(g.dmarcFail, total), affected_messages: g.dmarcFail, steps, records, guide_url: guide,
      });
      continue;
    }

    if (g.providerId && g.dkimAligned / g.messages < DKIM_WEAK_BELOW && material(g.messages - g.dkimAligned)) {
      const missed = g.messages - g.dkimAligned;
      const steps = [`Turn on custom-domain DKIM signing for ${domain.domain} in ${g.name}${guide ? ' (guide linked below)' : ''}, so mail stays aligned even when forwarding breaks SPF.`];
      const records: FixRecord[] = [];
      if (sig?.dkimCname) records.push({ type: 'CNAME', name: `${sig.dkimCname.selector}._domainkey.${domain.domain}`, value: sig.dkimCname.target });
      steps.push('Send a test message, then check the Sender inventory again in a day or two.');
      fixes.push({
        ...base, id: `dkim:${domain.id}:${g.key}`, kind: 'fix-dkim-alignment', severity: 'medium',
        title: `${g.name} sends ${fmtPct(share)} of your mail and fails DKIM alignment`,
        detail: `It passes today only through SPF. Forwarded mail loses SPF, so those messages would then fail DMARC.`,
        affected_pct: pct(missed, total), affected_messages: missed, steps, records, guide_url: guide,
      });
      continue;
    }

    if (!g.providerId && failShare >= AUTHORIZE_AT && material(g.dmarcFail)) {
      const s0 = g.senders[0];
      fixes.push({
        ...base, id: `investigate:${domain.id}:${g.key}`, kind: 'investigate-sender', severity: pct(g.dmarcFail, total) >= 5 ? 'high' : 'medium',
        title: `${fmtPct(share)} of your mail comes from ${g.name}, which we do not recognise`,
        detail: `${fmtPct(pct(g.dmarcFail, g.messages))} of it fails DMARC. If it is a service you use, authorize it. If not, it is likely spoofing, and enforcing DMARC will block it.`,
        affected_pct: pct(g.dmarcFail, total), affected_messages: g.dmarcFail,
        steps: [
          `Find out what ${s0?.reverse_dns || s0?.source_ip || 'this server'} is${s0?.org ? ` (network owner: ${s0.org})` : ''}.`,
          'If you send from it: add it to SPF and set up DKIM signing for it, then check again.',
          'If you do not: nothing to add. Keep it in view until you move to enforcement.',
        ],
        records: [], guide_url: null,
      });
      continue;
    }

    if (g.isNew && share >= 0.5) {
      fixes.push({
        ...base, id: `new:${domain.id}:${g.key}`, kind: 'review-new-sender', severity: 'low',
        title: `New sender: ${g.name}`,
        detail: `It started sending as ${domain.domain} in the last 7 days and passes DMARC (${fmtPct(pct(g.messages - g.dmarcFail, g.messages))} of its mail). Confirm it is yours.`,
        affected_pct: 0, affected_messages: 0,
        steps: ['Confirm you know this sender. If you do not, find out how it passes before it becomes a problem.'],
        records: [], guide_url: null,
      });
    }
  }

  return fixes.sort((a, b) => fixScore(b) - fixScore(a) || a.id.localeCompare(b.id));
}

export const fixScore = (f: Fix): number => SCORE[f.kind] * (f.affected_pct || f.share_pct / 10);
