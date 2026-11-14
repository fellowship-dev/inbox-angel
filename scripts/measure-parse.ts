// Worker-side cost of parsing and preparing one aggregate report, without a database or a test runner around it.
//   npx esbuild scripts/measure-parse.ts --bundle --platform=node --format=esm --outfile=/tmp/measure-parse.mjs
//   node --expose-gc --max-old-space-size=<MB> /tmp/measure-parse.mjs <records> [padMB]
// Prints one JSON line. Bisecting --max-old-space-size finds the smallest V8 heap the report needs (the live set, not garbage):
// compare it with the Workers isolate limit of 128 MB (https://developers.cloudflare.com/workers/platform/limits/).
import { gzipSync, strToU8 } from 'fflate';
import { randomBytes } from 'node:crypto';
import { parseDmarcEmail } from '../src/dmarc/parse-email';
import { storeStatements } from '@ready-set-mail/db';
import { toTuple } from '../src/dmarc/store-report';

const n = Number(process.argv[2] ?? 1000);
const pad = Number(process.argv[3] ?? 0);

function xml(records: number): string {
  const rec = (i: number) => `<record><row><source_ip>203.${(i >> 8) & 255}.${i & 255}.${(i % 250) + 1}</source_ip><count>${1 + (i % 7)}</count><policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>${i % 5 ? 'pass' : 'fail'}</spf></policy_evaluated></row><identifiers><header_from>a-corp.com</header_from></identifiers><auth_results><spf><domain>a-corp.com</domain><result>pass</result></spf></auth_results></record>`;
  const parts: string[] = [];
  for (let i = 0; i < records; i++) parts.push(rec(i));
  return `<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name><email>noreply@google.com</email><report_id>m</report_id><date_range><begin>${Math.floor(Date.now() / 1000) - 86400}</begin><end>${Math.floor(Date.now() / 1000) - 1}</end></date_range></report_metadata><policy_published><domain>a-corp.com</domain><p>none</p></policy_published>${parts.join('')}${pad ? '<!--' + (process.env.RANDPAD ? randomBytes(Math.floor(pad * 1048576 * 3 / 4)).toString('base64') : 'x'.repeat(pad * 1048576)) + '-->' : ''}</feedback>`;
}

const gz = gzipSync(strToU8(xml(n)));
(globalThis as any).gc?.();
const base = process.memoryUsage().heapUsed;
const cpu0 = process.cpuUsage();
const t0 = performance.now();
const report = await parseDmarcEmail(gz, true, undefined, { maxBytes: 64 * 1048576, maxRecords: 1e9 });
const t1 = performance.now();
const stmts = storeStatements({ workspaceId: 'ws', domainId: 1, report: { org_name: 'g', report_id: 'x', date_begin: 1, date_end: 2, total_count: 1, pass_count: 1, fail_count: 0, raw_xml: null, reporter_auth: 'pass', reporter_auth_domain: 'g', reporter_auth_reason: null }, records: report.records.map(toTuple), ingestToken: 't', day: '2026-11-14' });
const t2 = performance.now();
const cpu = process.cpuUsage(cpu0);
const usage = process.resourceUsage();
console.log(JSON.stringify({ records: n, padMB: pad, gzKB: Math.round(gz.length / 1024), parseMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1), cpuMs: Math.round((cpu.user + cpu.system) / 1000), statements: stmts.length, heapAfterMB: +((process.memoryUsage().heapUsed - base) / 1048576).toFixed(1), maxRssMB: +(usage.maxRSS / 1024).toFixed(0), parsed: report.records.length }));
