// DNS host detection: which service hosts a domain's zone (where its owner edits records), from its NS hosts.

import { normalizeName, type Resolver } from './doh';

export interface DnsHost {
  /** Stable key (e.g. `cloudflare`), or `unknown` when no NS host is recognised. */
  id: string;
  label: string;
}

export const UNKNOWN_DNS_HOST: DnsHost = { id: 'unknown', label: 'Unknown' };

/** First matching pattern wins. Patterns run against normalized (lowercase, no trailing dot) NS hosts. */
export const DNS_HOSTS: readonly (DnsHost & { pattern: RegExp })[] = [
  { id: 'cloudflare', label: 'Cloudflare', pattern: /(^|\.)cloudflare\.com$/ },
  { id: 'route53', label: 'AWS Route 53', pattern: /\.awsdns-/ },
  { id: 'godaddy', label: 'GoDaddy', pattern: /\.domaincontrol\.com$/ },
  { id: 'namecheap', label: 'Namecheap', pattern: /\.registrar-servers\.com$/ },
  { id: 'vercel', label: 'Vercel', pattern: /\.vercel-dns\.com$/ },
  { id: 'ns1', label: 'NS1', pattern: /\.nsone\.net$/ },
  { id: 'digitalocean', label: 'DigitalOcean', pattern: /\.digitalocean\.com$/ },
  { id: 'azure-dns', label: 'Azure DNS', pattern: /\.azure-dns\./ },
  { id: 'google-cloud-dns', label: 'Google Cloud DNS', pattern: /\.googledomains\.com$|^ns-cloud-/ },
  { id: 'porkbun', label: 'Porkbun', pattern: /\.porkbun\.com$/ },
  { id: 'gandi', label: 'Gandi', pattern: /\.gandi\.net$/ },
  { id: 'dnsimple', label: 'DNSimple', pattern: /\.dnsimple\.com$/ },
  { id: 'hover', label: 'Hover', pattern: /\.hover\.com$/ },
];

export function detectDnsHost(ns: readonly string[]): DnsHost {
  const hosts = ns.map(normalizeName);
  const hit = DNS_HOSTS.find(h => hosts.some(n => h.pattern.test(n)));
  return hit ? { id: hit.id, label: hit.label } : { ...UNKNOWN_DNS_HOST };
}

export interface NsLookup {
  /** `none`: NXDOMAIN or NODATA. `error`: unknown, never read as "no NS". */
  status: 'found' | 'none' | 'error';
  /** Raw NS hosts, normalized, sorted. */
  hosts: string[];
  error?: string;
}

export async function lookupNs(resolver: Resolver, domain: string): Promise<NsLookup> {
  const r = await resolver.resolve(domain, 'NS');
  if (r.status === 'error') return { status: 'error', hosts: [], error: r.error };
  if (r.status !== 'ok') return { status: 'none', hosts: [] };
  return { status: 'found', hosts: r.answers.map(a => normalizeName(a.data)).sort() };
}
