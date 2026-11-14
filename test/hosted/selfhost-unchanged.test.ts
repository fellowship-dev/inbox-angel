// Golden tests: with MODE unset (self-host) nothing about intake, canary, MTA-STS or the API changes, even
// when the hosted variables happen to be set. These pin today's behaviour.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Full signup + worker round trips: the 5 s default flakes when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });
import { gzipSync, strToU8 } from 'fflate';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { extractReport } from '../../src/dmarc/extract-report';
import { call, makeEnv } from '../auth/helpers';
import { reportWithDistinctIps } from '../helpers/big-report';
import { dmarcXml, fakeMessage, gzipReportMime, tlsRptJson, tlsRptMime } from '../helpers/mail';
import { HOSTED_ENV, nxdomain, quiet } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const { MODE: _m, SAAS_ENABLED: _s, ...HOSTED_VARS_ONLY } = HOSTED_ENV;

function selfHost(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address, workspace_id) VALUES (1, 'acme.com', 'rua@reports.acme.com', 'ws_default')").run();
  db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'base_domain', 'acme.com')").run();
  const env = makeEnv(db, { ...HOSTED_VARS_ONLY, ...extra }) as any; // hosted vars present, MODE unset
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, rows };
}

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('self-host is unchanged', () => {
  it('rua@reports.<base> files the report under the implicit workspace, by the report’s own domain, no token', async () => {
    const s = selfHost();
    const m = fakeMessage('rua@reports.acme.com', gzipReportMime(dmarcXml('acme.com', 'golden-1')));
    await worker.email(m, s.env, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    // Mail with no authentication results is stored (self-host never refuses it) as an unauthenticated report, under '<identity>|<id>' so it can
    // neither squat nor displace a counted report's id. Self-host counts every report by default, so the dashboard still shows it.
    expect(s.rows('SELECT workspace_id, report_id, reporter_tier FROM aggregate_reports')).toEqual([{ workspace_id: 'ws_default', report_id: '~unauth|golden-1', reporter_tier: 'unauthenticated' }]);
  });

  it('a server that counts every report does not restrict an unauthenticated one (no AUTHSERV_*: every report is) — 1,500 records are stored and enriched', async () => {
    const s = selfHost();
    const fetched = vi.fn(async () => new Response(JSON.stringify({ Status: 3 })));
    vi.stubGlobal('fetch', fetched);
    const m = fakeMessage('rua@reports.acme.com', gzipReportMime(reportWithDistinctIps('acme.com', 'big-1', 1500)));
    await worker.email(m, s.env, ctx);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(s.rows('SELECT COUNT(*) n FROM report_records')[0].n).toBe(1500);
    expect(fetched).toHaveBeenCalled(); // IP enrichment ran, as before
  });

  it('with REPORT_COUNTING=registry a self-hosted server applies the tier limits (the operator chose to defend)', async () => {
    const s = selfHost({ REPORT_COUNTING: 'registry' });
    const m = fakeMessage('rua@reports.acme.com', gzipReportMime(reportWithDistinctIps('acme.com', 'big-2', 1500)));
    await worker.email(m, s.env, ctx);
    expect(m.setReject).toHaveBeenCalledWith('Report has 1500 records; the limit is 200');
  });

  it('an unknown domain is rejected exactly as before', async () => {
    const s = selfHost();
    const m = fakeMessage('rua@reports.acme.com', gzipReportMime(dmarcXml('other.com')));
    await worker.email(m, s.env, ctx);
    expect(m.setReject).toHaveBeenCalledWith('Unknown domain other.com — not a registered Ready Set Mail inbox');
  });

  it('TLS-RPT: JSON body only, unknown policy domains skipped without a reject, attachments not read', async () => {
    const s = selfHost();
    const plain = fakeMessage('tls-rpt@reports.acme.com', tlsRptMime(tlsRptJson('acme.com')));
    await worker.email(plain, s.env, ctx);
    expect(s.rows('SELECT workspace_id, total_success FROM tls_reports')).toEqual([{ workspace_id: 'ws_default', total_success: 10 }]);

    const unknown = fakeMessage('tls-rpt@reports.acme.com', tlsRptMime(tlsRptJson('elsewhere.org')));
    await worker.email(unknown, s.env, ctx);
    expect(unknown.setReject).not.toHaveBeenCalled();

    const gz = fakeMessage('tls-rpt@reports.acme.com', tlsRptMime(tlsRptJson('acme.com'), true));
    await worker.email(gz, s.env, ctx);
    expect(gz.setReject).toHaveBeenCalledWith('Invalid TLS-RPT report JSON');
    expect(s.rows('SELECT * FROM tls_reports')).toHaveLength(1);
  });

  it('the parsers have no size cap unless one is asked for', () => {
    const big = '<?xml version="1.0"?><feedback>' + ' '.repeat(26 * 1024 * 1024) + '</feedback>';
    expect(extractReport(gzipSync(strToU8(big))).length).toBe(big.length);
  });

  it('the free check address is check+<token>@ on the reports domain (expiring, single use), even with CANARY_DOMAIN set', async () => {
    const s = selfHost();
    const res = await call(s.env, 'POST', '/api/check-sessions');
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.token).toMatch(/^[a-z2-7]{32}$/);
    expect(body.email).toBe(`check+${body.token}@reports.acme.com`);
    expect(s.rows('SELECT * FROM canary_tokens')).toHaveLength(1);
  });

  it('MTA-STS policy is served from the implicit workspace by hostname', async () => {
    const s = selfHost();
    s.db.sqlite.prepare("INSERT INTO mta_sts_config (domain_id, policy_id, workspace_id, mx_hosts, mode) VALUES (1, 'p1', 'ws_default', 'mx.acme.com', 'enforce')").run();
    const res = await worker.fetch(new Request('https://mta-sts.acme.com/.well-known/mta-sts.txt'), s.env, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('version: STSv1\nmode: enforce\nmx: mx.acme.com\nmax_age: 86400\n');
    expect((await worker.fetch(new Request('https://mta-sts.unknown.example/.well-known/mta-sts.txt'), s.env, ctx)).status).toBe(404);
  });

  it('has no hosted routes and writes nothing to the hosted tables', async () => {
    const s = selfHost();
    s.db.sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'o@acme.com', 'O')").run();
    expect((await call(s.env, 'GET', '/api/domains/1/hosted')).status).toBe(401);
    await worker.email(fakeMessage('rua@reports.acme.com', gzipReportMime(dmarcXml('acme.com', 'g2'))), s.env, ctx);
    for (const t of ['intake_tokens', 'hosted_domains', 'hosted_zones', 'canary_tokens']) expect(s.rows(`SELECT * FROM ${t}`)).toEqual([]);
  });
});
