// Polite HTTP helper for the public-listing sourcing scripts (read-only GETs, identified UA, retries).
export const USER_AGENT = 'inbox-angel-audit-fleet/1.0 (+https://github.com/fellowship-dev/inbox-angel-worker; public listings, read-only)';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function getJson<T>(url: string, opts: { retries?: number; headers?: Record<string, string> } = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...opts.headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 5000 * 2 ** attempt;
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(Math.min(wait, 70_000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Extract absolute http(s) URLs from text or HTML (href values and bare URLs). */
export function extractUrls(s: string): string[] {
  const decoded = s.replace(/&#x2F;/g, '/').replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
  return [...new Set(decoded.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])];
}
