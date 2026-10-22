// DNS-over-HTTPS resolver with an injectable fetch.
//
// Every lookup is classified into exactly one of four outcomes so callers can
// never confuse "the DNS said there is no record" with "we could not find out":
//
//   ok        – RCODE 0 and at least one record of the requested type
//   nodata    – RCODE 0 (NOERROR) but no record of the requested type
//   nxdomain  – RCODE 3, the name does not exist
//   error     – anything else: SERVFAIL/REFUSED/…, timeout, network failure,
//               HTTP error, non-JSON body, malformed answer section
//
// Only `nodata` and `nxdomain` mean "no record". `error` means "unknown".

export type DnsStatus = 'ok' | 'nodata' | 'nxdomain' | 'error';

export type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'TXT' | 'CNAME' | 'PTR';

export const RECORD_TYPE_CODES: Record<DnsRecordType, number> = {
  A: 1,
  CNAME: 5,
  MX: 15,
  PTR: 12,
  TXT: 16,
  AAAA: 28,
};

export interface DnsAnswer {
  name: string;
  type: number;
  ttl: number | null;
  /** Raw presentation data as returned by the DoH server. */
  data: string;
}

export interface DnsResponse {
  status: DnsStatus;
  /** Answers of the requested type only (CNAME chain entries are dropped). */
  answers: DnsAnswer[];
  /** DNS RCODE when one was received. */
  rcode?: number;
  /** Human-readable reason, set when status === 'error'. */
  error?: string;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  redirect?: 'follow' | 'manual' | 'error';
}

/** Anything shaped like the global `fetch` (a subset of it). */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponseLike>;

export interface ResolverOptions {
  /** Defaults to the global fetch, looked up at call time. */
  fetch?: FetchLike;
  /** DoH JSON endpoint. Default: https://cloudflare-dns.com/dns-query */
  endpoint?: string;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
}

export interface TxtResult {
  status: DnsStatus;
  /** One entry per TXT record, character-strings already concatenated. */
  records: string[];
  error?: string;
}

export interface Resolver {
  resolve(name: string, type: DnsRecordType): Promise<DnsResponse>;
  /** TXT convenience wrapper: decodes the presentation format. */
  txt(name: string): Promise<TxtResult>;
  /** The fetch used for non-DNS HTTP requests (policy files, SVGs). */
  fetch: FetchLike;
}

export const DEFAULT_DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init) as Promise<FetchResponseLike>;

export function normalizeName(name: string): string {
  return name.trim().replace(/\.$/, '').toLowerCase();
}

/**
 * Decode TXT presentation data into the logical record string.
 * Handles `"a" "b"` (multiple character-strings, joined), backslash escapes inside
 * quotes, and unquoted data (returned verbatim, as Google's DoH does).
 */
export function decodeTxtData(data: string): string {
  const s = data.trim();
  if (!s.startsWith('"')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          const next = s[i + 1];
          // \DDD decimal escape
          if (/\d/.test(next) && /^\d{3}$/.test(s.slice(i + 1, i + 4))) {
            out += String.fromCharCode(parseInt(s.slice(i + 1, i + 4), 10));
            i += 4;
            continue;
          }
          out += next;
          i += 2;
          continue;
        }
        out += s[i++];
      }
      i++; // closing quote
    } else {
      i++; // whitespace between character-strings
    }
  }
  return out;
}

function errorResponse(error: string, rcode?: number): DnsResponse {
  return { status: 'error', answers: [], error, ...(rcode !== undefined ? { rcode } : {}) };
}

const RCODE_NAMES: Record<number, string> = { 1: 'FORMERR', 2: 'SERVFAIL', 4: 'NOTIMP', 5: 'REFUSED' };

/** Classify a parsed DoH JSON body. Exported for tests. */
export function classifyDohBody(body: unknown, type: DnsRecordType): DnsResponse {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorResponse('malformed DoH response: not a JSON object');
  }
  const b = body as { Status?: unknown; Answer?: unknown };
  if (typeof b.Status !== 'number' || !Number.isInteger(b.Status)) {
    return errorResponse('malformed DoH response: missing Status');
  }
  const rcode = b.Status;
  if (rcode === 3) return { status: 'nxdomain', answers: [], rcode };
  if (rcode !== 0) return errorResponse(`DNS ${RCODE_NAMES[rcode] ?? `RCODE ${rcode}`}`, rcode);

  if (b.Answer === undefined || b.Answer === null) return { status: 'nodata', answers: [], rcode };
  if (!Array.isArray(b.Answer)) return errorResponse('malformed DoH response: Answer is not an array', rcode);

  const wanted = RECORD_TYPE_CODES[type];
  const answers: DnsAnswer[] = [];
  for (const entry of b.Answer) {
    if (typeof entry !== 'object' || entry === null) {
      return errorResponse('malformed DoH response: bad answer entry', rcode);
    }
    const e = entry as { name?: unknown; type?: unknown; TTL?: unknown; data?: unknown };
    if (typeof e.type !== 'number' || typeof e.data !== 'string') {
      return errorResponse('malformed DoH response: answer missing type/data', rcode);
    }
    if (e.type !== wanted) continue; // e.g. CNAME chain entries
    answers.push({
      name: typeof e.name === 'string' ? normalizeName(e.name) : '',
      type: e.type,
      ttl: typeof e.TTL === 'number' ? e.TTL : null,
      data: e.data,
    });
  }
  return answers.length > 0 ? { status: 'ok', answers, rcode } : { status: 'nodata', answers: [], rcode };
}

export function createResolver(options: ResolverOptions = {}): Resolver {
  const doFetch = options.fetch ?? defaultFetch;
  const endpoint = options.endpoint ?? DEFAULT_DOH_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 5000;

  async function resolve(rawName: string, type: DnsRecordType): Promise<DnsResponse> {
    const name = normalizeName(rawName);
    if (!name || name.length > 253 || name.split('.').some(l => l.length > 63 || l.length === 0)) {
      // An unqueryable name can never resolve; this is an input problem, not "no record".
      return errorResponse(`invalid DNS name: ${JSON.stringify(rawName)}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
        signal: controller.signal,
      });
      if (!res.ok) return errorResponse(`DoH HTTP ${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return errorResponse('malformed DoH response: invalid JSON');
      }
      return classifyDohBody(body, type);
    } catch (e) {
      const aborted = controller.signal.aborted;
      return errorResponse(aborted ? `DNS timeout after ${timeoutMs}ms` : `DNS request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    resolve,
    fetch: doFetch,
    async txt(name) {
      const r = await resolve(name, 'TXT');
      return {
        status: r.status,
        records: r.answers.map(a => decodeTxtData(a.data)),
        ...(r.error ? { error: r.error } : {}),
      };
    },
  };
}
