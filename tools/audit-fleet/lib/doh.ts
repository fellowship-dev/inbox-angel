// Polite DNS-over-HTTPS client: global rate limit, bounded in-flight, retries with backoff,
// resolver rotation. Distinguishes "no data" (NOERROR/NXDOMAIN) from transport/server failures.
import { sleep } from './http.ts';

export type RType = 'TXT' | 'MX' | 'NS';
export interface DohAnswer { type: number; data: string }
export interface DohResult { ok: boolean; status: number; answers: DohAnswer[]; error?: string }

export interface DohOptions {
  rps: number;            // max queries per second, across all workers
  resolvers: string[];    // DoH JSON endpoints, used round-robin
  retries: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export const RESOLVERS: Record<string, string> = {
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
};

export class DohClient {
  readonly stats = { queries: 0, retries: 0, failures: 0 };
  private nextSlot = 0;
  private rr = 0;
  private opts: DohOptions;
  constructor(opts: DohOptions) { this.opts = opts; }

  /** Reserve the next send slot so the global rate never exceeds opts.rps. */
  private async throttle() {
    const interval = 1000 / this.opts.rps;
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + interval;
    if (at > now) await sleep(at - now);
  }

  async query(name: string, type: RType): Promise<DohResult> {
    const f = this.opts.fetchImpl ?? fetch;
    let error = 'unknown';
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      await this.throttle();
      const base = this.opts.resolvers[this.rr++ % this.opts.resolvers.length];
      this.stats.queries++;
      if (attempt > 0) this.stats.retries++;
      try {
        const res = await f(`${base}?name=${encodeURIComponent(name)}&type=${type}`, {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          error = `http-${res.status}`;
          await sleep(Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random()));
          continue;
        }
        if (!res.ok) { error = `http-${res.status}`; break; }
        const j = await res.json() as { Status: number; Answer?: DohAnswer[] };
        // Status 0 NOERROR, 3 NXDOMAIN = definitive answers. 2 SERVFAIL = retry (may be transient).
        if (j.Status === 0 || j.Status === 3) {
          return { ok: true, status: j.Status, answers: j.Answer ?? [] };
        }
        error = `rcode-${j.Status}`;
        await sleep(500 * 2 ** attempt);
      } catch (e) {
        error = (e as Error).name === 'TimeoutError' ? 'timeout' : 'network';
        await sleep(500 * 2 ** attempt);
      }
    }
    this.stats.failures++;
    return { ok: false, status: -1, answers: [], error };
  }

  /** TXT strings (split strings re-joined). */
  async txt(name: string): Promise<{ ok: boolean; status: number; records: string[]; error?: string }> {
    const r = await this.query(name, 'TXT');
    return {
      ok: r.ok, status: r.status, error: r.error,
      records: r.answers.filter(a => a.type === 16).map(a => a.data.replace(/^"|"$/g, '').replace(/"\s*"/g, '')),
    };
  }
}
