// Seeded report data for the analytics tests: one story per domain, dated relative to a fixed "now".
import { forWorkspace } from '@inbox-angel/db';

export const DAY = 86400;

export interface Entry {
  ip: string;
  count: number;
  /** Does this entry pass DMARC (aligned SPF or DKIM)? The report totals use it, like policy_evaluated does. */
  pass: boolean;
  spf?: [result: string, domain: string] | null;
  dkim?: [result: string, domain: string] | null;
  reverse_dns?: string | null;
  base_domain?: string | null;
  org?: string | null;
  /** Only report this entry on these days-ago offsets (default: every day in `days`). */
  daysAgo?: number[];
}

/** One aggregate report per day-ago, holding every entry that applies on that day. Returns the report count. */
export async function seedDomainReports(db: any, workspaceId: string, domainId: number, header: string, days: number[], entries: Entry[], now = Math.floor(Date.now() / 1000)) {
  const q = forWorkspace(db, workspaceId);
  let n = 0;
  for (const ago of days) {
    const todays = entries.filter((e) => !e.daysAgo || e.daysAgo.includes(ago));
    if (!todays.length) continue;
    const total = todays.reduce((s, e) => s + e.count, 0);
    const pass = todays.filter((e) => e.pass).reduce((s, e) => s + e.count, 0);
    const begin = Math.floor((now - ago * DAY) / DAY) * DAY;
    const rep = await q.reports.insertAggregate({ domain_id: domainId, org_name: 'google.com', report_id: `r-${domainId}-${ago}`, date_begin: begin, date_end: begin + DAY - 1, total_count: total, pass_count: pass, fail_count: total - pass, raw_xml: null });
    await q.reports.insertRecords(todays.map((e) => ({
      report_id: Number(rep.meta.last_row_id), source_ip: e.ip, count: e.count, disposition: e.pass ? 'none' : 'quarantine',
      spf_result: e.spf === null ? null : (e.spf?.[0] ?? 'pass'), spf_domain: e.spf === null ? null : (e.spf?.[1] ?? header),
      dkim_result: e.dkim === null ? null : (e.dkim?.[0] ?? 'pass'), dkim_domain: e.dkim === null ? null : (e.dkim?.[1] ?? header),
      header_from: header, reverse_dns: e.reverse_dns ?? null, base_domain: e.base_domain ?? null, org: e.org ?? null,
    })));
    n++;
  }
  return n;
}

export const lastDays = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

/** The story used by most tests: Google clean, Mailchimp unaligned, an unknown host failing, a brand-new SendGrid. */
export const STORY: Entry[] = [
  { ip: '209.85.220.41', count: 80, pass: true, reverse_dns: 'mail-sor-f41.google.com', base_domain: 'google.com', org: 'Google LLC' },
  { ip: '198.2.180.1', count: 12, pass: false, spf: ['pass', 'mcsv.net'], dkim: ['pass', 'mcsv.net'], reverse_dns: 'mail180.mcsv.net', base_domain: 'mcsv.net', org: 'The Rocket Science Group' },
  { ip: '203.0.113.9', count: 3, pass: false, spf: ['fail', 'acme.com'], dkim: ['none', 'acme.com'], org: 'Shady Hosting' },
  { ip: '167.89.1.1', count: 5, pass: true, spf: ['pass', 'em.acme.com'], dkim: ['pass', 'acme.com'], reverse_dns: 'o1.em.sendgrid.net', base_domain: 'sendgrid.net', org: 'SendGrid', daysAgo: [1, 2] },
];
