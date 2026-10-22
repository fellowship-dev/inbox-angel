import { normalizeName, type Resolver } from './doh';

export interface MxHost {
  priority: number;
  host: string;
}

export type MxLookupStatus =
  | 'found'
  /** no MX records (NXDOMAIN or NODATA) */
  | 'none'
  /** RFC 7505 null MX ("0 ."): the domain explicitly accepts no mail */
  | 'null-mx'
  | 'error';

export interface MxLookup {
  status: MxLookupStatus;
  hosts: MxHost[];
  error?: string;
}

/** Parse "10 mail.example.com." → {priority, host}; null when malformed. */
export function parseMxData(data: string): MxHost | null {
  const m = data.trim().match(/^(\d+)\s+(\S+)$/);
  if (!m) return null;
  return { priority: parseInt(m[1], 10), host: m[2] === '.' ? '.' : normalizeName(m[2]) };
}

export async function lookupMx(resolver: Resolver, domain: string): Promise<MxLookup> {
  const r = await resolver.resolve(domain, 'MX');
  if (r.status === 'error') return { status: 'error', hosts: [], error: r.error };
  if (r.status !== 'ok') return { status: 'none', hosts: [] };
  const hosts: MxHost[] = [];
  for (const a of r.answers) {
    const mx = parseMxData(a.data);
    if (!mx) return { status: 'error', hosts: [], error: `malformed MX answer: ${JSON.stringify(a.data)}` };
    hosts.push(mx);
  }
  hosts.sort((x, y) => x.priority - y.priority || x.host.localeCompare(y.host));
  if (hosts.length === 1 && hosts[0].host === '.') return { status: 'null-mx', hosts: [] };
  return { status: 'found', hosts: hosts.filter(h => h.host !== '.') };
}
