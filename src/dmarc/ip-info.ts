// IP enrichment — reverse DNS + ASN/country via free DNS services only.
// PTR records:   Cloudflare DoH (cloudflare-dns.com) — no key, no rate limit
// ASN / country: Team Cymru DNS whois (origin.asn.cymru.com) — free, DNS-based
// Results are cached in the ip_info D1 table; TTL = 30 days.

import type { IpInfo } from './types';
import { globals } from '../db/scope';

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const CACHE_TTL_DAYS = 30;

// ── DNS-over-HTTPS helpers ────────────────────────────────────

async function dohQuery(name: string, type: string): Promise<string[]> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) return [];
    const data = await res.json() as { Answer?: { data: string }[] };
    return (data.Answer ?? []).map(a => a.data.replace(/\.$/, '').trim());
  } catch {
    return [];
  }
}

// PTR record for an IPv4 address
async function lookupPtr(ip: string): Promise<string | null> {
  if (!isIPv4(ip)) return null; // skip IPv6 for now
  const reversed = ip.split('.').reverse().join('.') + '.in-addr.arpa';
  const answers = await dohQuery(reversed, 'PTR');
  return answers[0] ?? null;
}

// Team Cymru DNS whois: returns { asn, countryCode, org } for an IPv4
// Query: {rev}.origin.asn.cymru.com TXT  → "ASN | prefix | CC | registry | date"
// Query: AS{asn}.asn.cymru.com       TXT  → "ASN | CC | registry | date | ORG NAME, CC"
async function lookupAsn(ip: string): Promise<{ asn: string | null; countryCode: string | null; org: string | null }> {
  if (!isIPv4(ip)) return { asn: null, countryCode: null, org: null };
  const reversed = ip.split('.').reverse().join('.');
  const originAnswers = await dohQuery(`${reversed}.origin.asn.cymru.com`, 'TXT');
  if (!originAnswers.length) return { asn: null, countryCode: null, org: null };

  // Strip surrounding quotes if present
  const originTxt = originAnswers[0].replace(/^"|"$/g, '');
  const parts = originTxt.split('|').map(p => p.trim());
  const asn = parts[0] || null;
  const countryCode = parts[2] || null;

  let org: string | null = null;
  if (asn) {
    const asnAnswers = await dohQuery(`AS${asn}.asn.cymru.com`, 'TXT');
    if (asnAnswers.length) {
      const asnTxt = asnAnswers[0].replace(/^"|"$/g, '');
      const asnParts = asnTxt.split('|').map(p => p.trim());
      // Last part is "ORG NAME, CC" — take everything before the trailing ", CC"
      const raw = asnParts[asnParts.length - 1] ?? '';
      org = raw.replace(/,\s*[A-Z]{2}$/, '').trim() || null;
    }
  }

  return { asn, countryCode, org };
}

// ── Friendly org names ────────────────────────────────────────

const ORG_FRIENDLY: readonly (readonly [substring: string, friendlyName: string])[] = [
  ['GOOGLE', 'Google'],
  ['MICROSOFT', 'Microsoft'],
  ['AMAZON', 'Amazon'],
  ['CLOUDFLARE', 'Cloudflare'],
  ['SENDGRID', 'SendGrid'],
  ['MAILCHIMP', 'Mailchimp'],
  ['MANDRILL', 'Mailchimp'],
  ['POSTMARK', 'Postmark'],
  ['HUBSPOT', 'HubSpot'],
  ['PROTON', 'Proton Mail'],
  ['ZOHO', 'Zoho'],
  ['MAILGUN', 'Mailgun'],
  ['BREVO', 'Brevo'],
  ['SENDINBLUE', 'Brevo'],
  ['MAILJET', 'Mailjet'],
  ['RACKSPACE', 'Rackspace'],
  ['OVHCLOUD', 'OVHcloud'],
  ['OVH SAS', 'OVHcloud'],
  ['HETZNER', 'Hetzner'],
  ['DIGITALOCEAN', 'DigitalOcean'],
  ['LINODE', 'Linode'],
  ['FASTLY', 'Fastly'],
  ['AKAMAI', 'Akamai'],
  ['ORACLE', 'Oracle'],
  ['MIMECAST', 'Mimecast'],
  ['BARRACUDA', 'Barracuda'],
  ['ZENDESK', 'Zendesk'],
  ['RESEND', 'Resend'],
];

/** Map raw ASN org strings to human-readable names */
export function friendlyOrg(raw: string | null): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  for (const [substring, friendly] of ORG_FRIENDLY) {
    if (upper.includes(substring)) return friendly;
  }
  return raw;
}

function isIPv4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

function baseDomain(hostname: string): string {
  const parts = hostname.replace(/\.$/, '').split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

// ── Public API ────────────────────────────────────────────────

export async function getIpInfo(ip: string): Promise<IpInfo> {
  const [ptr, { asn, countryCode, org }] = await Promise.all([
    lookupPtr(ip),
    lookupAsn(ip),
  ]);

  return {
    ip,
    reverse_dns: ptr,
    base_domain: ptr ? baseDomain(ptr) : null,
    country_code: countryCode,
    country_name: null, // not available without a geo DB — country_code is enough
    subdivision: null,
    city: null,
    org: friendlyOrg(org),
    asn: asn ?? null,
  };
}

// ── D1 cache helpers ──────────────────────────────────────────

export async function getCachedIpInfo(db: D1Database, ip: string): Promise<IpInfo | null> {
  const row = await globals(db).ipInfo.get(ip);
  if (!row) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - row.fetched_at;
  if (ageSeconds > CACHE_TTL_DAYS * 86400) return null; // expired
  return {
    ip: row.ip,
    reverse_dns: row.reverse_dns,
    base_domain: row.base_domain,
    country_code: row.country_code,
    country_name: null,
    subdivision: null,
    city: null,
    org: row.org,
    asn: row.asn,
  };
}

export async function cacheIpInfo(db: D1Database, info: IpInfo & { asn?: string | null }): Promise<void> {
  await globals(db).ipInfo.upsert({
    ip: info.ip,
    reverse_dns: info.reverse_dns,
    base_domain: info.base_domain,
    country_code: info.country_code,
    org: info.org ?? null,
    asn: info.asn ?? null,
  });
}

/** Look-ups in flight at once while enriching a report's uncached IPs. */
const ENRICH_CONCURRENCY = 5;

/**
 * Enrichment for every distinct IP of a report with a fixed number of D1 queries, whatever the report's size: ONE query reads the
 * cache for all of them (json_each in a batch), at most `maxNew` uncached IPs (busiest first, `weight` = messages) are looked up over
 * DNS-over-HTTPS, and ONE query writes the new rows back. Cache trouble never fails a report: an unreadable cache is an empty one.
 */
export async function enrichIps(db: D1Database | undefined, ips: readonly string[], maxNew: number | undefined, weight: (ip: string) => number = () => 0): Promise<Map<string, IpInfo>> {
  const out = new Map<string, IpInfo>();
  const g = db ? globals(db) : null;
  let cached = new Map<string, import('@ready-set-mail/db').IpInfoRow>();
  if (g) {
    try { cached = await g.ipInfo.getMany(ips); } catch (e) { console.warn('ip-info: cache read failed, enriching without it:', e instanceof Error ? e.message : e); }
  }
  const now = Math.floor(Date.now() / 1000);
  const todo: string[] = [];
  for (const ip of ips) {
    const row = cached.get(ip);
    if (row && now - row.fetched_at <= CACHE_TTL_DAYS * 86400) {
      out.set(ip, { ip, reverse_dns: row.reverse_dns, base_domain: row.base_domain, country_code: row.country_code, country_name: null, subdivision: null, city: null, org: row.org, asn: row.asn });
    } else todo.push(ip);
  }
  todo.sort((a, b) => weight(b) - weight(a));
  const fresh: IpInfo[] = [];
  const lookups = todo.slice(0, maxNew ?? todo.length);
  for (let i = 0; i < lookups.length; i += ENRICH_CONCURRENCY) {
    fresh.push(...await Promise.all(lookups.slice(i, i + ENRICH_CONCURRENCY).map((ip) => getIpInfo(ip))));
  }
  for (const info of fresh) out.set(info.ip, info);
  if (g && fresh.length) await g.ipInfo.putMany(fresh.map((i) => ({ ip: i.ip, reverse_dns: i.reverse_dns, base_domain: i.base_domain, country_code: i.country_code, org: i.org, asn: i.asn }))).catch(() => {}); // best effort
  return out;
}
