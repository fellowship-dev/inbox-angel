// DomainReport fixtures: a port of unzip-inboxangel outreach-tools/tests/conftest.py make_rec / bimi_rec.
import type { BimiLookup, DetectedProvider, DomainReport, SpfIssue } from '@inbox-angel/dns-checks';

export const CHECKED = '2026-10-22T18:00:00.000Z';

export interface RecOptions {
  spf?: DomainReport['spf']['status'];
  spfRaw?: string;
  spfRaws?: string[];
  spfIssues?: SpfIssue[];
  spfIncludes?: string[];
  lookups?: number;
  dmarc?: DomainReport['dmarc']['status'];
  dmarcRaw?: string;
  dmarcPolicy?: 'none' | 'quarantine' | 'reject';
  rua?: string[];
  dmarcRaws?: string[];
  valid?: boolean;
  mx?: [DomainReport['mx']['status'], string[]];
  providers?: DetectedProvider[];
  dkim?: string[];
  mtaSts?: DomainReport['mtaSts']['status'];
  errors?: DomainReport['errors'];
  /** A dns-checks DNS host id. */
  dnsHost?: string;
  verdict?: 'strict' | 'soft' | 'open' | 'missing';
  /** Typed loosely on purpose: malformed values must not crash (Python test_malformed_pct). */
  pct?: unknown;
  bimi?: BimiLookup;
}

const NO_ASSET = { url: null, status: 'not-declared' as const };

export function makeRec(domain = 'example.com', o: RecOptions = {}): DomainReport {
  const {
    spf = 'none', spfRaw, spfRaws, spfIssues = [], spfIncludes = [], lookups = 0,
    dmarc = 'none', dmarcRaw, dmarcPolicy = 'none', rua = [], dmarcRaws, valid = true,
    mx = ['found', ['aspmx.l.google.com']], providers = [], dkim = [], mtaSts = 'none', errors = [],
    dnsHost = 'cloudflare', verdict = 'strict', pct = 100, bimi,
  } = o;
  const spfRec = spfRaw ? { raw: spfRaw, mechanisms: [], terms: [], verdict, lookup_count: lookups } : null;
  const dmarcRec = dmarcRaw
    ? { raw: dmarcRaw, policy: dmarcPolicy, subdomainPolicy: dmarcPolicy, pct: pct as number, rua, ruf: [], adkim: 'r' as const, aspf: 'r' as const, valid, issues: valid ? [] : ['bad tag'] }
    : null;
  const labels: Record<string, string> = { cloudflare: 'Cloudflare', godaddy: 'GoDaddy' };
  return {
    domain,
    mx: { status: mx[0], hosts: mx[1].map(host => ({ priority: 10, host })) },
    spf: {
      domain, status: spf, record: spfRec, lookupCount: lookups, voidLookupCount: 0, lookupLimitExceeded: lookups > 10, voidLimitExceeded: false,
      issues: spfIssues, includes: spfIncludes, ...(spfRaws ? { rawRecords: spfRaws } : {}),
    },
    dmarc: {
      status: dmarc, domain, record: dmarcRec, foundAt: dmarcRec ? `_dmarc.${domain}` : null, inherited: false, organizationalDomain: domain,
      ...(dmarcRaws ? { rawRecords: dmarcRaws } : {}),
    },
    dkim: {
      found: dkim.map(s => ({ status: 'found' as const, selector: s, name: `${s}._domainkey.${domain}`, record: { raw: 'v=DKIM1; p=abc', version: 'DKIM1', keyType: 'rsa', present: true, revoked: false } })),
      errors: [], scanned: 36,
    },
    mtaSts: { status: mtaSts, txt: null, policy: null, policyUrl: `https://mta-sts.${domain}/.well-known/mta-sts.txt`, issues: [] },
    bimi: bimi ?? { status: 'none', raw: null, foundAt: null, logo: { ...NO_ASSET }, vmc: { ...NO_ASSET, validated: false } },
    providers,
    ns: { status: 'found', hosts: ['a.ns.cloudflare.com'] },
    dnsHost: { id: dnsHost, label: labels[dnsHost] ?? dnsHost },
    grade: { level: 0, label: 'Unprotected', complete: errors.length === 0, reasons: [], nextSteps: [] },
    errors,
  };
}

type AssetStatus = BimiLookup['logo']['status'];

/** A BIMI record whose logo / certificate checks came back as given. */
export function bimiRec({ logo = 'present', vmc = 'present', raw }: { logo?: AssetStatus; vmc?: AssetStatus; raw?: string } = {}): BimiLookup {
  const lUrl = logo === 'not-declared' ? null : 'https://example.com/logo.svg';
  const aUrl = vmc === 'not-declared' ? null : 'https://example.com/vmc.pem';
  return {
    status: 'found', raw: raw ?? `v=BIMI1; l=${lUrl ?? ''}; a=${aUrl ?? ''}`, foundAt: 'default._bimi.example.com',
    logo: { url: lUrl, status: logo }, vmc: { url: aUrl, status: vmc, validated: false },
  };
}

export const GOOGLE: DetectedProvider = { id: 'google-workspace', name: 'Google Workspace', kind: 'mailbox', evidence: ['mx:aspmx.l.google.com'] };
export const RESEND: DetectedProvider = { id: 'resend', name: 'Resend', kind: 'sender', evidence: ['spf-include:resend.com'] };
export const SES: DetectedProvider = { id: 'amazon-ses', name: 'Amazon SES', kind: 'sender', evidence: ['spf-include:amazonses.com'] };
export const SENDGRID: DetectedProvider = { id: 'sendgrid', name: 'SendGrid', kind: 'sender', evidence: ['spf-include:sendgrid.net'] };
export const M365: DetectedProvider = { id: 'microsoft-365', name: 'Microsoft 365', kind: 'mailbox', evidence: ['mx:x.mail.protection.outlook.com'] };
