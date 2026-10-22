// The seam between the fleet and the DNS checks.
//
//   type Checker = (domain: string) => Promise<DomainReport>
//
// `createLegacyChecker` is a TEMPORARY adapter over today's src/ DNS parsers.
// When packages/dns-checks lands, replace the single `checker` construction in run.ts with its
// `checkDomain` (mapped to DomainReport) — nothing else in the fleet depends on how checks run.
import { parseSpfRecord, parseDmarcRecord } from '../../../src/email/dns-check.ts';
import { detectProviders, getAllDkimSelectors, matchDkimProvider } from '../../../dashboard/src/email-service-providers.ts';
import type { DohClient } from './doh.ts';

export interface DomainReport {
  domain: string;
  checkedAt: string;
  /** Hard failures that make a field unreliable (e.g. "spf:timeout"). Empty = clean. */
  errors: string[];
  /** false when the domain doesn't resolve at all (NXDOMAIN on apex NS/MX/TXT). */
  exists: boolean;
  spf: { present: boolean; verdict?: 'strict' | 'soft' | 'open' | 'missing'; lookups?: number; overLimit?: boolean; multiple?: boolean; includes?: string[] };
  dmarc: { present: boolean; policy?: 'none' | 'quarantine' | 'reject'; pct?: number; hasRua?: boolean; subdomainPolicy?: string };
  dkim: { found: boolean; selectors: string[] };
  mx: { present: boolean; hosts: string[]; provider?: string | null };
  /** Authoritative DNS host (derived from NS records), e.g. "cloudflare". */
  dnsHost: string | null;
  /** Detected sending providers (from SPF includes + DKIM selectors). */
  senders: string[];
  mtaSts: boolean;
}

export type Checker = (domain: string) => Promise<DomainReport>;

const DNS_HOSTS: [RegExp, string][] = [
  [/\.ns\.cloudflare\.com$/, 'Cloudflare'], [/\.awsdns-/, 'AWS Route 53'], [/\.domaincontrol\.com$/, 'GoDaddy'],
  [/\.googledomains\.com$|\.google\.com$/, 'Google Domains/Cloud DNS'], [/\.registrar-servers\.com$/, 'Namecheap'],
  [/\.vercel-dns\.com$/, 'Vercel'], [/\.netlify\.com$|\.nsone\.net$/, 'Netlify/NS1'], [/\.digitalocean\.com$/, 'DigitalOcean'],
  [/\.azure-dns\./, 'Azure DNS'], [/\.dnsimple\.com$/, 'DNSimple'], [/\.hover\.com$/, 'Hover'], [/\.porkbun\.com$/, 'Porkbun'],
  [/\.wixdns\.net$/, 'Wix'], [/\.squarespacedns\.com$/, 'Squarespace'], [/\.gandi\.net$/, 'Gandi'], [/\.ovh\.net$/, 'OVH'],
  [/\.name\.com$/, 'Name.com'], [/\.dynadot\.com$/, 'Dynadot'], [/\.hetzner\.(com|de)$|\.your-server\.de$/, 'Hetzner'],
  [/\.linode\.com$/, 'Linode'], [/\.he\.net$/, 'Hurricane Electric'], [/\.bunny\.net$/, 'Bunny'], [/\.ultradns\./, 'UltraDNS'],
  [/\.dnsmadeeasy\.com$/, 'DNS Made Easy'], [/\.cloudns\.net$/, 'ClouDNS'], [/\.fly\.io$/, 'Fly.io'], [/\.vultr\.com$/, 'Vultr'],
];
export function detectDnsHost(ns: string[]): string | null {
  for (const n of ns) for (const [re, name] of DNS_HOSTS) if (re.test(n.toLowerCase().replace(/\.$/, ''))) return name;
  return ns.length ? 'other' : null;
}

const MX_PROVIDERS: [RegExp, string][] = [
  [/google(mail)?\.com$|googlemail/, 'Google Workspace'], [/protection\.outlook\.com$|mail\.protection/, 'Microsoft 365'],
  [/protonmail\.ch$|proton\.me$/, 'Proton Mail'], [/zoho\.(com|eu|in)$/, 'Zoho Mail'], [/fastmail\.com$|messagingengine\.com$/, 'Fastmail'],
  [/improvmx\.com$/, 'ImprovMX'], [/forwardemail\.net$/, 'Forward Email'], [/mxroute\.com$/, 'MXRoute'], [/privateemail\.com$/, 'Namecheap Email'],
  [/secureserver\.net$/, 'GoDaddy Email'], [/cloudflare\.net$|mx\.cloudflare/, 'Cloudflare Email Routing'], [/mailgun\.org$/, 'Mailgun'],
  [/icloud\.com$/, 'iCloud'], [/migadu\.com$/, 'Migadu'], [/titan\.email$/, 'Titan'], [/hostinger/, 'Hostinger'], [/ovh\.net$/, 'OVH'],
];
export function detectMxProvider(hosts: string[]): string | null {
  for (const h of hosts) for (const [re, name] of MX_PROVIDERS) if (re.test(h.toLowerCase().replace(/\.$/, ''))) return name;
  return hosts.length ? 'other' : null;
}

/** Common extra DKIM selectors beyond the provider registry. */
const EXTRA_SELECTORS = ['selector1', 'selector2', 'google', 's1', 's2', 'k1', 'k2', 'k3', 'resend', 'smtp', 'default', 'dkim', 'mail', 'pm', 'cm', 'mandrill', 'scph0', 'zendesk1', 'sig1'];
export const DKIM_SELECTORS = [...new Set([...getAllDkimSelectors(), ...EXTRA_SELECTORS])];

const MAX_SPF_WALK = 20;
/** Selectors shared by several providers / generic names: probed for DKIM presence but not used to attribute a sender. */
const AMBIGUOUS_SELECTORS = new Set(['default', 'dkim', 'mail', 's1', 's2', 'k1', 'k2', 'k3', 'smtp', 'x', 'cm', 'sig1']);

export function createLegacyChecker(doh: DohClient): Checker {
  return async function check(domain: string): Promise<DomainReport> {
    const errors: string[] = [];
    const note = (what: string, r: { ok: boolean; error?: string }) => { if (!r.ok) errors.push(`${what}:${r.error ?? 'failed'}`); };

    const [apex, dmarcQ, mxQ, nsQ, mtaQ] = await Promise.all([
      doh.txt(domain), doh.txt(`_dmarc.${domain}`), doh.query(domain, 'MX'), doh.query(domain, 'NS'), doh.txt(`_mta-sts.${domain}`),
    ]);
    note('txt', apex); note('dmarc', dmarcQ); note('mx', mxQ); note('ns', nsQ); note('mtasts', mtaQ);

    const nsHosts = nsQ.answers.filter(a => a.type === 2).map(a => a.data.toLowerCase());
    // Null MX (RFC 7505, target ".") means "does not receive mail"; not counted as a mail host.
    const mxHosts = mxQ.answers.filter(a => a.type === 15).map(a => a.data.split(/\s+/)[1] ?? a.data).filter(h => h && h !== '.');
    const exists = !(apex.status === 3 && nsQ.status === 3);

    // SPF
    const spfRecords = apex.records.filter(r => /^v=spf1(\s|$)/i.test(r));
    const spfRaw = spfRecords[0];
    const spf: DomainReport['spf'] = { present: !!spfRaw };
    let spfText = '';
    if (spfRaw) {
      const parsed = parseSpfRecord(spfRaw);
      spf.verdict = parsed.verdict;
      spf.multiple = spfRecords.length > 1;
      spf.includes = (spfRaw.match(/include:[^\s]+/gi) ?? []).map(s => s.slice(8).toLowerCase());
      spfText = spfRaw;
      // Walk includes/redirects to count the DNS-lookup budget (10 max per RFC 7208).
      const visited = new Set<string>([domain]);
      let lookups = 0, walkFailed = false;
      const walk = async (rec: string, depth: number) => {
        const kids: string[] = [];
        for (const tok of rec.split(/\s+/)) {
          const t = tok.toLowerCase().replace(/^[+\-~?]/, '');
          if (t.startsWith('include:')) { lookups++; kids.push(t.slice(8)); }
          else if (t.startsWith('redirect=')) { lookups++; kids.push(t.slice(9)); }
          else if (t === 'a' || t.startsWith('a:') || t.startsWith('a/') || t === 'mx' || t.startsWith('mx:') || t.startsWith('mx/') || t === 'ptr' || t.startsWith('ptr:') || t.startsWith('exists:')) lookups++;
        }
        for (const k of kids) {
          if (visited.has(k) || visited.size > MAX_SPF_WALK || depth > 10) continue;
          visited.add(k);
          const r = await doh.txt(k);
          if (!r.ok) { walkFailed = true; continue; }
          const child = r.records.find(x => /^v=spf1(\s|$)/i.test(x));
          if (child) { spfText += ' ' + child; await walk(child, depth + 1); }
        }
      };
      await walk(spfRaw, 0);
      if (walkFailed) errors.push('spf-walk:partial');
      spf.lookups = lookups;
      spf.overLimit = lookups > 10;
    }

    // DMARC (subdomain falls back to org domain)
    let dmarcRaw = dmarcQ.records.find(r => /^v=DMARC1/i.test(r));
    const labels = domain.split('.');
    if (!dmarcRaw && labels.length > 2) {
      const org = await doh.txt(`_dmarc.${labels.slice(-2).join('.')}`);
      note('dmarc-org', org);
      dmarcRaw = org.records.find(r => /^v=DMARC1/i.test(r));
    }
    const dmarc: DomainReport['dmarc'] = { present: !!dmarcRaw };
    if (dmarcRaw) {
      const d = parseDmarcRecord(dmarcRaw);
      dmarc.policy = d.policy; dmarc.pct = d.pct; dmarc.hasRua = d.rua.length > 0; dmarc.subdomainPolicy = d.subdomainPolicy;
    }

    // DKIM: probe known selectors (only for domains that publish SPF or MX, i.e. that plausibly handle mail)
    const selectors: string[] = [];
    if (exists && (spf.present || mxHosts.length > 0)) {
      // Wildcard guard: if a random selector also "exists", the zone answers for any name, so hits mean nothing.
      const canary = await doh.txt(`ia-canary-x7q._domainkey.${domain}`);
      note('dkim', canary);
      const wildcard = canary.records.some(x => x.includes('v=DKIM1') || x.includes('p='));
      const results = wildcard ? [] : await Promise.all(DKIM_SELECTORS.map(async s => {
        const r = await doh.txt(`${s}._domainkey.${domain}`);
        if (!r.ok) { errors.push(`dkim:${r.error}`); return null; }
        // A key with empty p= is a revoked key, not a working one.
        const hit = r.records.find(x => (x.includes('v=DKIM1') || x.includes('k=') || x.includes('p=')) && !/p=\s*(;|$)/.test(x));
        return hit ? s : null;
      }));
      for (const s of results) if (s) selectors.push(s);
    }

    const senders = new Set<string>(detectProviders(spfText).map(p => p.name));
    for (const s of selectors) {
      const p = matchDkimProvider(s);
      if (p && !AMBIGUOUS_SELECTORS.has(s)) senders.add(p.name);
    }
    // detectProviders only knows `include:` of the top record; also scan flattened includes text.
    for (const inc of spf.includes ?? []) if (/amazonses\.com$/.test(inc)) senders.add('Amazon SES');

    return {
      domain, checkedAt: new Date().toISOString(), errors: [...new Set(errors)], exists,
      spf, dmarc, dkim: { found: selectors.length > 0, selectors },
      mx: { present: mxHosts.length > 0, hosts: mxHosts.slice(0, 5), provider: detectMxProvider(mxHosts) },
      dnsHost: detectDnsHost(nsHosts), senders: [...senders].sort(), mtaSts: mtaQ.records.some(r => /^v=STSv1/i.test(r)),
    };
  };
}
