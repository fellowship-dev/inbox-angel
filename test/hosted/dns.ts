import { createResolver, type Resolver } from '@inbox-angel/dns-checks';

export interface DnsName { TXT?: string[]; CNAME?: string; error?: boolean }

/**
 * A resolver over a table of names. Unknown names are NXDOMAIN; a known name without the requested
 * type is NODATA; `error: true` is SERVFAIL.
 */
export function dnsFrom(table: Record<string, DnsName>): Resolver {
  return createResolver({
    fetch: async url => {
      const u = new URL(url);
      const name = u.searchParams.get('name') ?? '';
      const type = u.searchParams.get('type') ?? '';
      const entry = table[name];
      const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (!entry) return body({ Status: 3 });
      if (entry.error) return body({ Status: 2 });
      if (type === 'CNAME' && entry.CNAME) return body({ Status: 0, Answer: [{ name, type: 5, TTL: 60, data: `${entry.CNAME}.` }] });
      if (type === 'TXT' && entry.TXT) return body({ Status: 0, Answer: entry.TXT.map(t => ({ name, type: 16, TTL: 60, data: `"${t}"` })) });
      return body({ Status: 0 });
    },
  });
}
