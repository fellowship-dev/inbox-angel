// Measurement harness for the limits in docs/hosted.md ("Measured limits"). Skipped unless MEASURE_N is set; run one case per process so
// the peak resident set (process.resourceUsage().maxRSS, KB) belongs to that case:
//   for n in 0 1 200 5000 20000; do MEASURE_N=$n npx vitest run --config vitest.node.config.mts test/hosted/measure.test.ts; done
// MEASURE_PAD_MB=N pads the XML with a comment of N MB (a report at the decompressed-size cap rather than the record-count cap).
import { describe, it, vi } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';

vi.setConfig({ testTimeout: 300_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { parseDmarcEmail } from '../../src/dmarc/parse-email';
import { storeStatements } from '@ready-set-mail/db';
import { toTuple } from '../../src/dmarc/store-report';
import { fakeMessage, mimeWithAttachment } from '../helpers/mail';
import { reportWithDistinctIps } from '../helpers/big-report';
import { nxdomain, twoWorkspaces } from './world';

const N = process.env.MEASURE_N;
const PAD_MB = Number(process.env.MEASURE_PAD_MB ?? 0);
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const mb = (b: number) => (b / 1048576).toFixed(1);
const cpu = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };

describe.runIf(N !== undefined)('measure', () => {
  it(`records=${N} pad=${PAD_MB}MB`, async () => {
    nxdomain();
    const n = Number(N);
    let text = n > 0 ? reportWithDistinctIps('a-corp.com', 'm1', n) : '<?xml version="1.0"?><feedback/>';
    if (PAD_MB) text = text.replace('</feedback>', '<!--' + 'x'.repeat(PAD_MB * 1048576) + '--></feedback>');
    const bytes = strToU8(text);
    const gz = gzipSync(bytes);
    const base = process.resourceUsage().maxRSS;
    const out: Record<string, unknown> = { records: n, xmlMB: +mb(bytes.length), gzMB: +mb(gz.length), baselineRssMB: +mb(base * 1024) };

    if (n > 0) {
      // Worker-side CPU: parse (offline: no DNS, no D1) and building the storing statements. D1 execution time is not Worker CPU.
      let t = performance.now(), c = cpu();
      const report = await parseDmarcEmail(gz, true, undefined, { maxBytes: 64 * 1048576, maxRecords: 1e9 });
      out.parseWallMs = Math.round(performance.now() - t); out.parseCpuMs = Math.round(cpu() - c);
      t = performance.now(); c = cpu();
      const stmts = storeStatements({ workspaceId: 'ws_a', domainId: 1, report: { org_name: 'g', report_id: 'x', date_begin: 1, date_end: 2, total_count: 1, pass_count: 1, fail_count: 0, raw_xml: null, reporter_auth: 'pass', reporter_auth_domain: 'g', reporter_auth_reason: null }, records: report.records.map(toTuple), ingestToken: 't', day: '2026-11-14' });
      out.buildWallMs = Math.round(performance.now() - t); out.buildCpuMs = Math.round(cpu() - c); out.statements = stmts.length;
    }

    // Whole path through email(), against the in-memory SQLite test D1 (its SQL execution is in-process here, remote in production).
    const w = await twoWorkspaces({ INTAKE_MAX_RECORDS_PER_REPORT: '100000', INTAKE_MAX_DECOMPRESSED_BYTES: String(25 * 1048576) });
    const m = fakeMessage(`rua+${w.tokenA}@rua.readysetmail.com`, mimeWithAttachment(gz, 'r.xml.gz', 'application/gzip'), { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com' } });
    const t0 = performance.now(), c0 = cpu();
    await worker.email(m, w.env as any, ctx);
    out.emailWallMs = Math.round(performance.now() - t0); out.emailCpuMs = Math.round(cpu() - c0);
    out.rejected = m.setReject.mock.calls[0]?.[0] ?? null;
    out.stored = w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n;
    const usage = process.resourceUsage();
    out.peakRssMB = +mb(usage.maxRSS * 1024); out.peakRssOverBaselineMB = +mb((usage.maxRSS - base) * 1024);
    process.stdout.write('MEASURE ' + JSON.stringify(out) + '\n');
  });
});
