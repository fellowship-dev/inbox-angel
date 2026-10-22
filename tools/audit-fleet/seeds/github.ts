// Sources product homepages from public GitHub repo metadata (unauthenticated search API; ~10 req/min).
//   node seeds/github.ts <outDir>
// Repos whose README mentions Resend / Supabase auth etc. and that declare a `homepage`.
// Writes <outDir>/raw-github.csv (domain,source,ref). Never uses a token or logs in.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateDomain, parsePsl, BUILTIN_PSL } from '../lib/domain.ts';
import { toCsv } from '../lib/csv.ts';
import { getJson, sleep } from '../lib/http.ts';

const outDir = process.argv[2] ?? 'out/seeds';
mkdirSync(outDir, { recursive: true });
const pslPath = join(outDir, 'psl.dat');
const psl = existsSync(pslPath) ? parsePsl(readFileSync(pslPath, 'utf8')) : BUILTIN_PSL;

interface Repo { homepage: string | null; fork: boolean; archived: boolean }
interface Resp { items: Repo[]; total_count: number }

const QUERIES = [
  'resend in:readme',
  'resend.com in:readme',
  'supabase auth in:readme',
  'supabase magic link in:readme',
  'topic:saas supabase',
  'topic:saas resend',
  'topic:micro-saas',
  'topic:indiehackers',
  'topic:side-project saas',
];
// Slice each query by star range so we get past the 1000-result cap per query.
const STAR_BANDS = ['0', '1', '2..3', '4..10', '11..50', '51..500', '>500'];

const out = new Map<string, string>();
let reqs = 0, urls = 0;
outer: for (const q of QUERIES) {
  for (const band of STAR_BANDS) {
    for (let page = 1; page <= 10; page++) {
      const full = `${q} stars:${band} archived:false fork:false`;
      let r: Resp;
      try {
        r = await getJson<Resp>(`https://api.github.com/search/repositories?q=${encodeURIComponent(full)}&per_page=100&page=${page}&sort=updated`, {
          headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
      } catch (e) { console.error(`github: stopping query slice (${(e as Error).message})`); break; }
      reqs++;
      await sleep(7000); // stay under the 10 req/min unauthenticated search limit
      for (const it of r.items) {
        if (!it.homepage) continue;
        urls++;
        const c = candidateDomain(it.homepage, psl);
        if ('domain' in c && !out.has(c.domain)) out.set(c.domain, q);
      }
      if (r.items.length < 100) break;
    }
    if (out.size >= 1500) break outer;
  }
}
writeFileSync(join(outDir, 'raw-github.csv'), toCsv(['domain', 'source', 'ref'], [...out].map(([d, q]) => [d, 'github', q])));
console.error(`github: ${reqs} requests, ${urls} homepages -> ${out.size} unique domains`);
