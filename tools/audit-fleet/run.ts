// Audit a CSV of domains: DNS-only, read-only.
//   node run.ts --in out/seeds/seeds.csv [--out out] [--shard 1/4] [--concurrency 10] [--rps 20]
//               [--resolvers cloudflare,google] [--retries 3] [--limit N] [--resume]
// Writes <out>/results[.IofN].jsonl (one JSON object per domain), aggregate[.IofN].json, run-meta[.IofN].json.
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCsvObjects } from './lib/csv.ts';
import { parseShard, takeShard } from './lib/shard.ts';
import { DohClient, RESOLVERS } from './lib/doh.ts';
import { createLegacyChecker, type Checker } from './lib/checker.ts';
import { aggregate } from './lib/aggregate.ts';
import { readJsonlFile } from './lib/io.ts';

const { values: a } = parseArgs({
  options: {
    in: { type: 'string', default: 'out/seeds/seeds.csv' },
    out: { type: 'string', default: 'out' },
    shard: { type: 'string' },
    concurrency: { type: 'string', default: '10' },
    rps: { type: 'string', default: '20' },
    resolvers: { type: 'string', default: 'cloudflare,google' },
    retries: { type: 'string', default: '3' },
    limit: { type: 'string' },
    resume: { type: 'boolean', default: false },
  },
});

const shard = a.shard ? parseShard(a.shard) : { index: 1, total: 1 };
const tag = shard.total > 1 ? `.${shard.index}of${shard.total}` : '';
mkdirSync(a.out!, { recursive: true });

// Unique, ordered domain list so every devbox derives the same shards from the same CSV.
const all = [...new Set(parseCsvObjects(readFileSync(a.in!, 'utf8')).map(r => r.domain?.trim().toLowerCase()).filter(Boolean))].sort();
let mine = takeShard(all, shard);
if (a.limit) mine = mine.slice(0, Number(a.limit));

const resultsPath = join(a.out!, `results${tag}.jsonl`);
const done = new Set(a.resume ? readJsonlFile(resultsPath).map(r => r.domain) : []);
if (!a.resume && existsSync(resultsPath)) writeFileSync(resultsPath, '');
const todo = mine.filter(d => !done.has(d));

const doh = new DohClient({
  rps: Number(a.rps), retries: Number(a.retries), timeoutMs: 8000,
  resolvers: a.resolvers!.split(',').map(r => RESOLVERS[r.trim()] ?? r.trim()),
});
// ── The seam: swap this one line for packages/dns-checks when it lands. ──
const checker: Checker = createLegacyChecker(doh);

const started = Date.now();
let next = 0, finished = 0;
async function worker() {
  while (next < todo.length) {
    const domain = todo[next++];
    let report;
    try { report = await checker(domain); }
    catch (e) {
      report = { domain, checkedAt: new Date().toISOString(), errors: [`crash:${(e as Error).message}`], exists: true,
        spf: { present: false }, dmarc: { present: false }, dkim: { found: false, selectors: [] },
        mx: { present: false, hosts: [] }, dnsHost: null, senders: [], mtaSts: false };
    }
    appendFileSync(resultsPath, JSON.stringify(report) + '\n');
    if (++finished % 50 === 0) {
      const s = (Date.now() - started) / 1000;
      console.error(`[${tag || 'all'}] ${finished}/${todo.length} domains, ${s.toFixed(0)}s, ${doh.stats.queries} queries, ${doh.stats.failures} failed`);
    }
  }
}
await Promise.all(Array.from({ length: Number(a.concurrency) }, worker));

const reports = readJsonlFile(resultsPath);
const agg = aggregate(reports);
writeFileSync(join(a.out!, `aggregate${tag}.json`), JSON.stringify(agg, null, 2) + '\n');
const meta = {
  shard: `${shard.index}/${shard.total}`, seedDomains: all.length, shardDomains: mine.length, checkedThisRun: todo.length,
  runtimeSeconds: Math.round((Date.now() - started) / 1000), ...doh.stats,
  queryFailureRate: doh.stats.queries ? Math.round((doh.stats.failures / doh.stats.queries) * 10000) / 100 : 0,
};
writeFileSync(join(a.out!, `run-meta${tag}.json`), JSON.stringify(meta, null, 2) + '\n');
console.error(JSON.stringify(meta));
