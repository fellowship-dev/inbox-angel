// BIMI: `default._bimi.<domain>` TXT, with presence checks of the SVG logo and VMC.
// The VMC is only checked for *presence/reachability*; its certificate chain is NOT validated.

import { normalizeName, type Resolver } from './doh';
import { organizationalDomain } from './org-domain';

export type BimiStatus = 'found' | 'none' | 'declined' | 'multiple' | 'error';

export interface BimiAsset {
  url: string | null;
  /** present: fetched OK · missing: HTTP error · invalid: wrong content · not-declared: tag absent · unreachable: network failure */
  status: 'present' | 'missing' | 'invalid' | 'not-declared' | 'unreachable';
  detail?: string;
}

export interface BimiLookup {
  status: BimiStatus;
  raw: string | null;
  foundAt: string | null;
  logo: BimiAsset;
  vmc: BimiAsset & { validated: false };
  error?: string;
}

function parseBimiTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if (k && !(k in tags)) tags[k] = part.slice(i + 1).trim();
  }
  return tags;
}

async function checkLogo(resolver: Resolver, url: string | undefined): Promise<BimiAsset> {
  if (!url) return { url: null, status: 'not-declared' };
  if (!url.startsWith('https://')) return { url, status: 'invalid', detail: 'BIMI assets must be served over HTTPS' };
  try {
    const res = await resolver.fetch(url, { headers: { Accept: 'image/svg+xml' } });
    if (!res.ok) return { url, status: 'missing', detail: `HTTP ${res.status}` };
    const body = (await res.text()).trimStart().slice(0, 2048);
    const ctype = res.headers.get('content-type') ?? '';
    if (!/<svg[\s>]/i.test(body) && !/svg/i.test(ctype)) return { url, status: 'invalid', detail: 'not an SVG document' };
    if (!/<svg[\s>]/i.test(body)) return { url, status: 'invalid', detail: 'body has no <svg> element' };
    return { url, status: 'present' };
  } catch (e) {
    return { url, status: 'unreachable', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function checkVmc(resolver: Resolver, url: string | undefined): Promise<BimiLookup['vmc']> {
  if (!url) return { url: null, status: 'not-declared', validated: false };
  if (!url.startsWith('https://')) return { url, status: 'invalid', detail: 'BIMI assets must be served over HTTPS', validated: false };
  try {
    const res = await resolver.fetch(url, { headers: { Accept: 'application/x-pem-file, */*' } });
    if (!res.ok) return { url, status: 'missing', detail: `HTTP ${res.status}`, validated: false };
    const body = await res.text();
    if (!body.includes('-----BEGIN CERTIFICATE-----')) return { url, status: 'invalid', detail: 'not a PEM certificate', validated: false };
    return { url, status: 'present', validated: false };
  } catch (e) {
    return { url, status: 'unreachable', detail: e instanceof Error ? e.message : String(e), validated: false };
  }
}

export async function lookupBimi(resolver: Resolver, domain: string, selector = 'default'): Promise<BimiLookup> {
  const name = normalizeName(domain);
  const org = organizationalDomain(name);
  const empty = { raw: null, foundAt: null, logo: { url: null, status: 'not-declared' as const }, vmc: { url: null, status: 'not-declared' as const, validated: false as const } };

  const names = [name, ...(org && org !== name ? [org] : [])];
  for (const n of names) {
    const at = `${selector}._bimi.${n}`;
    const r = await resolver.txt(at);
    if (r.status === 'error') return { ...empty, status: 'error', error: r.error ?? 'DNS error' };
    const recs = r.records.filter(x => /^\s*v=BIMI1\s*(;|$)/i.test(x));
    if (recs.length > 1) return { ...empty, status: 'multiple', foundAt: at };
    if (recs.length === 1) {
      const raw = recs[0].trim();
      const tags = parseBimiTags(raw);
      if ((tags['l'] ?? '') === '' && (tags['a'] ?? '') === '') return { ...empty, status: 'declined', raw, foundAt: at };
      const [logo, vmc] = await Promise.all([checkLogo(resolver, tags['l'] || undefined), checkVmc(resolver, tags['a'] || undefined)]);
      return { status: 'found', raw, foundAt: at, logo, vmc };
    }
  }
  return { ...empty, status: 'none' };
}
