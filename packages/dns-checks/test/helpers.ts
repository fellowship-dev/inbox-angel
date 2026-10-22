import { createResolver, type FetchLike, type FetchResponseLike, type Resolver } from '../src/doh';

const TYPE_CODE: Record<string, number> = { A: 1, CNAME: 5, PTR: 12, MX: 15, TXT: 16, AAAA: 28 };

export type Zone = Record<string, string[] | 'SERVFAIL' | 'TIMEOUT' | 'HTTP500' | 'GARBAGE' | 'NODATA'>;

/** Build a DoH fetch backed by a table keyed `"TYPE name"`. Unknown keys: NXDOMAIN. */
export function dohFetch(zone: Zone, calls: string[] = [], http: Record<string, FetchResponseLike | Error> = {}): FetchLike {
  return async (url: string) => {
    if (!url.includes('dns-query')) {
      calls.push(url);
      const h = http[url];
      if (h instanceof Error) throw h;
      if (!h) return resp(404, 'not found');
      return h;
    }
    const u = new URL(url);
    const name = u.searchParams.get('name')!;
    const type = u.searchParams.get('type')!;
    const key = `${type} ${name}`;
    calls.push(key);
    const v = zone[key];
    if (v === 'TIMEOUT') throw new Error('socket timeout');
    if (v === 'HTTP500') return resp(500, 'oops');
    if (v === 'GARBAGE') return resp(200, '<html>not json</html>');
    if (v === 'SERVFAIL') return resp(200, JSON.stringify({ Status: 2 }));
    if (v === undefined) return resp(200, JSON.stringify({ Status: 3 }));
    if (v === 'NODATA' || v.length === 0) return resp(200, JSON.stringify({ Status: 0 }));
    return resp(200, JSON.stringify({
      Status: 0,
      Answer: v.map(data => ({ name, type: TYPE_CODE[type], TTL: 60, data: type === 'TXT' ? `"${data}"` : data })),
    }));
  };
}

export function resp(status: number, body: string, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

export function fakeResolver(zone: Zone, calls: string[] = [], http: Record<string, FetchResponseLike | Error> = {}): Resolver {
  return createResolver({ fetch: dohFetch(zone, calls, http) });
}
