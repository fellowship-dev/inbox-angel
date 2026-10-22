// Combine raw-*.csv from the sourcing scripts into the final seed list.
//   node seeds/build.ts [seedDir=out/seeds] [--target 1400]
// Output: <seedDir>/../seeds.csv (domain,sources) + seeds-summary.json (counts only).
// These files contain third-party domains: they live under out/ (git-ignored) and must never be committed.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvObjects, toCsv } from '../lib/csv.ts';
import { selectSeeds, sourceMix, type RawSeed } from '../lib/select.ts';

const dir = process.argv[2] ?? 'out/seeds';
const target = Number(process.argv[3]?.replace('--target=', '') ?? 1400);
const raw: RawSeed[] = readdirSync(dir).filter(f => /^raw-.*\.csv$/.test(f))
  .flatMap(f => parseCsvObjects(readFileSync(join(dir, f), 'utf8')) as unknown as RawSeed[]);
const seeds = selectSeeds(raw, target);
const outPath = join(dir, '..', 'seeds.csv');
writeFileSync(outPath, toCsv(['domain', 'sources'], seeds.map(s => [s.domain, s.sources.join('|')])));
const perSource: Record<string, number> = {};
for (const r of raw) perSource[r.source] = (perSource[r.source] ?? 0) + 1;
const summary = { rawCandidates: raw.length, selected: seeds.length, rawBySource: perSource, selectedMix: sourceMix(seeds) };
writeFileSync(join(dir, '..', 'seeds-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
