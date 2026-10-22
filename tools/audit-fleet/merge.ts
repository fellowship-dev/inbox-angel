// Combine shard outputs into one results.jsonl + aggregate.json (aggregates are recomputed from the
// per-domain rows, never by summing shard aggregates).
//   node merge.ts [--dir out] [--into out/merged]
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregate } from './lib/aggregate.ts';
import { mergeReports, readJsonlFile, shardResultFiles } from './lib/io.ts';

const { values: a } = parseArgs({ options: { dir: { type: 'string', default: 'out' }, into: { type: 'string' } } });
const dir = a.dir!;
const into = a.into ?? join(dir, 'merged');
const files = shardResultFiles(dir);
if (files.length === 0) throw new Error(`no results.<i>of<n>.jsonl files in ${dir}`);

// Verify we have every shard of the same fleet size.
const totals = new Set(files.map(f => Number(/\.(\d+)of(\d+)\.jsonl$/.exec(f)![2])));
if (totals.size > 1) throw new Error(`mixed shard totals: ${[...totals].join(',')}`);
const total = [...totals][0];
const have = new Set(files.map(f => Number(/\.(\d+)of\d+\.jsonl$/.exec(f)![1])));
const missing = Array.from({ length: total }, (_, i) => i + 1).filter(i => !have.has(i));
if (missing.length) console.error(`WARNING: missing shard(s) ${missing.join(', ')} of ${total} — merged result is partial`);

const reports = mergeReports(files.map(readJsonlFile));
mkdirSync(into, { recursive: true });
writeFileSync(join(into, 'results.jsonl'), reports.map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(into, 'aggregate.json'), JSON.stringify(aggregate(reports), null, 2) + '\n');

// Sum run metadata for runtime/error reporting.
const metas = readdirSync(dir).filter(f => /^run-meta\.\d+of\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
const sum = (k: string) => metas.reduce((s, m) => s + (m[k] ?? 0), 0);
const queries = sum('queries'), failures = sum('failures');
writeFileSync(join(into, 'run-meta.json'), JSON.stringify({
  shards: files.length, shardsExpected: total, domains: reports.length, queries, retries: sum('retries'), failures,
  queryFailureRate: queries ? Math.round((failures / queries) * 10000) / 100 : 0,
  maxShardRuntimeSeconds: Math.max(0, ...metas.map(m => m.runtimeSeconds ?? 0)),
}, null, 2) + '\n');
console.error(`merged ${reports.length} domains from ${files.length}/${total} shards -> ${into}`);
