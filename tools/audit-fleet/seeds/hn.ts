// Sources domains from Hacker News via the public Algolia API (no auth).
//   node seeds/hn.ts <outDir>
// Writes <outDir>/raw-hn-show.csv and raw-hn-workingon.csv  (domain,source,ref)
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateDomain, parsePsl, BUILTIN_PSL } from '../lib/domain.ts';
import { toCsv } from '../lib/csv.ts';
import { getJson, extractUrls, sleep } from '../lib/http.ts';

const outDir = process.argv[2] ?? 'out/seeds';
mkdirSync(outDir, { recursive: true });
const pslPath = join(outDir, 'psl.dat');
const psl = existsSync(pslPath) ? parsePsl(readFileSync(pslPath, 'utf8')) : BUILTIN_PSL;

const API = 'https://hn.algolia.com/api/v1';
interface Hit { objectID: string; url?: string | null; title?: string; points?: number; created_at_i: number; comment_text?: string | null; story_id?: number }
interface Resp { hits: Hit[]; nbPages: number }

const seen = new Map<string, { source: string; ref: string }>();
const stats: Record<string, { urls: number; kept: number }> = {};
function add(source: string, url: string, ref: string) {
  const s = (stats[source] ??= { urls: 0, kept: 0 });
  s.urls++;
  const c = candidateDomain(url, psl);
  if ('domain' in c) { s.kept++; if (!seen.has(`${source}|${c.domain}`)) seen.set(`${source}|${c.domain}`, { source, ref }); }
}

// 1) Show HN posts: keyword queries across all time (email/auth stack relevance) …
const KEYWORDS = ['resend', 'supabase', 'saas', 'transactional email', 'magic link', 'auth', 'indie', 'api', 'startup', 'tool'];
const now = Math.floor(Date.now() / 1000);
for (const q of KEYWORDS) {
  for (let page = 0; page < 20; page++) {
    const r = await getJson<Resp>(`${API}/search?tags=show_hn&query=${encodeURIComponent(q)}&hitsPerPage=100&page=${page}`);
    for (const h of r.hits) if (h.url) add('hn-show', h.url, `kw:${q}`);
    if (page + 1 >= r.nbPages) break;
    await sleep(250);
  }
}
// … and recent Show HN by month windows (last 30 months), points >= 3 to skip dead posts.
for (let m = 0; m < 30; m++) {
  const to = now - m * 30 * 86400;
  const from = to - 30 * 86400;
  for (let page = 0; page < 10; page++) {
    const r = await getJson<Resp>(`${API}/search_by_date?tags=show_hn&hitsPerPage=1000&page=${page}&numericFilters=${encodeURIComponent(`created_at_i>${from},created_at_i<=${to},points>=3`)}`);
    for (const h of r.hits) if (h.url) add('hn-show', h.url, `win:${m}`);
    if (page + 1 >= r.nbPages) break;
    await sleep(250);
  }
}

// 2) "What are you working on?" / "Show your project" Ask HN threads: URLs in top-level comments.
const threads = new Map<string, string>();
for (const q of ['What are you working on', 'Ask HN: Share your project', 'Ask HN: What did you build', 'Ask HN: Show me your side project']) {
  for (let page = 0; page < 5; page++) {
    const r = await getJson<Resp>(`${API}/search?tags=story,ask_hn&query=${encodeURIComponent(q)}&hitsPerPage=100&page=${page}`);
    for (const h of r.hits) if (/working on|share your|show me your|did you build|side project/i.test(h.title ?? '')) threads.set(h.objectID, h.title ?? '');
    if (page + 1 >= r.nbPages) break;
    await sleep(250);
  }
}
for (const id of [...threads.keys()].slice(0, 120)) {
  for (let page = 0; page < 5; page++) {
    const r = await getJson<Resp>(`${API}/search?tags=comment,story_${id}&hitsPerPage=1000&page=${page}`);
    for (const h of r.hits) for (const u of extractUrls(h.comment_text ?? '')) add('hn-workingon', u, `thread:${id}`);
    if (page + 1 >= r.nbPages) break;
    await sleep(250);
  }
}

for (const src of ['hn-show', 'hn-workingon']) {
  const rows = [...seen.values()].filter(v => v.source === src);
  const entries = [...seen].filter(([k]) => k.startsWith(src + '|')).map(([k, v]) => [k.slice(src.length + 1), v.source, v.ref]);
  writeFileSync(join(outDir, `raw-${src}.csv`), toCsv(['domain', 'source', 'ref'], entries));
  console.error(`${src}: ${stats[src]?.urls ?? 0} urls -> ${rows.length} unique domains (pre-dedupe across sources)`);
}
