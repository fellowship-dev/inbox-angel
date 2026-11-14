// What the review of PR 150 required before HOSTED_CONNECT_REPORTS can ever be "all". Each block failed on main 03bbb76.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { handleHostedEmail } from '../../src/hosted/intake';
import { tokenizeAuthResults } from '../../src/email/auth-results';
import { authProof, parseAuthResults } from '../../src/email/parse-headers';
import { reportIntakePreflightItems } from '../../src/hosted/report-intake-check';
import { loadTenant } from '../../src/tenancy/load';
import { reportAddressStatus } from '../../src/hosted/report-address';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const RUA = 'rua.readysetmail.com';
const FIXED = `rua@${RUA}`;
const ID = 'mx.cloudflare.net';

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A report mail whose From is `from` (the helper's default is Google's address). */
const mime = (domain: string, id: string, from?: string) => {
  // An authenticated sender's report names its own organisation (report_metadata/email), as a real one does.
  const m = gzipReportMime(dmarcXml(domain, id, from ? from.slice(from.lastIndexOf('@') + 1) : undefined));
  return from ? m.replace('From: noreply-dmarc-support@google.com', `From: ${from}`) : m;
};

async function world(extra: Record<string, string> = {}) {
  const w = await twoWorkspaces({ HOSTED_CONNECT_REPORTS: 'all', ...extra });
  w.db.sqlite.prepare("UPDATE domains SET rua_address = ?, verified_via = 'txt', reports_connected_at = 1 WHERE id = 1").run(FIXED); // a-corp.com, connected
  const send = async (domain: string, id: string, o: { envelope?: string; from?: string; ar?: string } = {}) => {
    const m = fakeMessage(FIXED, mime(domain, id, o.from), { from: o.envelope ?? 'x@sender.example', headers: o.ar ? { 'authentication-results': o.ar } : {} });
    await handleHostedEmail(m, w.env);
    return m;
  };
  return { ...w, send };
}

describe('1. a stranger cannot use up the unattributed budget for everyone', () => {
  it('60 messages from rotating envelope domains for unconnected domains, then a legitimate unauthenticated report for a connected domain: accepted', async () => {
    const w = await world({ INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY: '50' });
    for (let i = 0; i < 60; i++) expect((await w.send(`victim${i}.example`, `f${i}`, { envelope: `x@rot${i}.example` })).setReject).toHaveBeenCalledOnce();
    const legit = await w.send('a-corp.com', 'legit', { envelope: 'reports@small-provider.example' });
    expect(legit.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT reporter_tier FROM aggregate_reports")).toEqual([{ reporter_tier: 'unauthenticated' }]);
  });

  it('20 DKIM-signing organisations flooding unconnected domains do not block an authenticated non-registry receiver for a connected domain', async () => {
    const w = await world({ INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY: '20', INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY: '1' });
    for (let i = 0; i < 25; i++) {
      const org = `signer${i}.example`;
      await w.send(`victim${i}.example`, `a${i}`, { from: `dmarc@${org}`, envelope: `bounce@${org}`, ar: `${ID}; dkim=pass header.d=${org}` });
    }
    const receiver = await w.send('a-corp.com', 'smallisp', { from: 'dmarc@small-isp.example', envelope: 'bounce@small-isp.example', ar: `${ID}; dkim=pass header.d=small-isp.example` });
    expect(receiver.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reporter_tier FROM aggregate_reports')).toEqual([{ reporter_tier: 'unknown' }]);
  });

  it('pure volume: past the per-minute peek ceiling non-registry mail is held back (unauthenticated refused, see final-points.test.ts), registry mail still goes through', async () => {
    const w = await world({ INTAKE_MAX_FIXED_PEEKS_PER_MINUTE: '3' });
    for (let i = 0; i < 3; i++) await w.send(`victim${i}.example`, `p${i}`);
    expect((await w.send('a-corp.com', 'held')).setReject).toHaveBeenCalledWith('The service is not accepting reports from unauthenticated senders right now');
    const google = await w.send('a-corp.com', 'google-ok', { envelope: 'noreply-dmarc-support@google.com', ar: `${ID}; dkim=pass header.d=google.com` });
    expect(google.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT reporter_tier FROM aggregate_reports")).toEqual([{ reporter_tier: 'counted' }]);
  });
});

describe('2. the unattributed budget does not grow the table past its total', () => {
  it('60 messages against a total of 50: at most 50 per-sender rows, and none once the total is used up', async () => {
    const w = await world({ INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY: '50' });
    for (let i = 0; i < 60; i++) await w.send(`victim${i}.example`, `g${i}`, { envelope: `x@rot${i}.example` });
    expect(w.rows("SELECT COUNT(*) AS n FROM intake_quota WHERE scope LIKE 'f:s:%'")).toEqual([{ n: 50 }]);
    expect(w.rows("SELECT messages FROM intake_quota WHERE scope = 'f:unauthenticated'")).toEqual([{ messages: 50 }]);
  });
});

describe('3. header.i is never a DKIM domain', () => {
  const HEADER = `${ID}; dkim=pass header.i=@google.com x-cf=1 header.d=attacker.example`;
  it('the tolerant skip dropped header.d; header.i is not used in its place', () => {
    const t = tokenizeAuthResults(HEADER);
    expect(t.ok && t.results[0]?.skipped).toBe(true);
    expect(authProof(parseAuthResults(HEADER)).dkimPassOrgs).toEqual([]);
    expect(authProof(parseAuthResults(`${ID}; dkim=pass header.i=@google.com`)).dkimPassOrgs).toEqual([]);
  });
  it('through the shared address: stored, not counted as Google', async () => {
    const w = await world();
    expect((await w.send('a-corp.com', 'hi', { envelope: 'noreply-dmarc-support@google.com', ar: HEADER })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reporter_tier FROM aggregate_reports')).toEqual([{ reporter_tier: 'unauthenticated' }]);
  });
});

describe('4. reports received since connecting are counted by when we received them', () => {
  it('a report covering the day before the connection (date_begin before connected_at) shows in the uncounted notice', async () => {
    const w = await world();
    const connectedAt = Math.floor(Date.now() / 1000) - 60;
    w.db.sqlite.prepare('UPDATE domains SET reports_connected_at = ? WHERE id = 1').run(connectedAt);
    expect((await w.send('a-corp.com', 'yesterday')).setReject).not.toHaveBeenCalled(); // its period is in 2018 (dmarcXml), received now
    const tenant = await loadTenant(w.env, { workspaceId: 'ws_a' });
    const domain = (await tenant.scope.domains.getById(1))!;
    const s = await reportAddressStatus(tenant, domain) as any;
    expect(s.visibility.uncounted.reports).toBe(1);
  });
});

describe('5. a property value that property cannot have drops its whole result', () => {
  it.each([
    ['smtp.helo with a space', `${ID}; spf=pass smtp.helo="evil host"; dkim=pass header.d=google.com`],
    ['smtp.helo with a parenthesis', `${ID}; spf=pass smtp.helo="x(y"; dkim=pass header.d=google.com`],
    ['smtp.mailfrom domain not a host', `${ID}; spf=pass smtp.mailfrom=a@"b c"; dkim=pass header.d=google.com`],
  ])('%s', (_n, h) => {
    const t = tokenizeAuthResults(h);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.results.map((r) => r.method)).toEqual(['dkim']);
  });
  it('a DKIM result whose header.d is not a host is dropped, not believed in part', () => {
    const t = tokenizeAuthResults(`${ID}; dkim=pass header.d="google.com x" header.s=s1`);
    expect(t.ok && t.results).toEqual([]);
  });
  it('real values pass: host names, address literals, mailboxes, selectors, the null sender', () => {
    const t = tokenizeAuthResults(`${ID}; spf=pass smtp.helo=[192.0.2.1] smtp.mailfrom=""; dkim=pass header.d=google.com header.i=@google.com header.s=20230601; dmarc=pass header.from=google.com`);
    expect(t.ok && t.results.map((r) => r.method)).toEqual(['spf', 'dkim', 'dmarc']);
  });
});

describe('7. owner to all', () => {
  const env = (e: Record<string, string>) => ({ MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: RUA, ...e }) as any;
  it('the setup check always shows the switch\'s current value', () => {
    expect(reportIntakePreflightItems(env({ HOSTED_CONNECT_REPORTS: 'all' }))).toEqual([expect.objectContaining({ severity: 'note', setting: 'HOSTED_CONNECT_REPORTS', message: expect.stringMatching(/^HOSTED_CONNECT_REPORTS is "all"/) })]);
    expect(reportIntakePreflightItems(env({ OWNER_EMAIL: 'o@x.example' }))[0]?.message).toMatch(/^HOSTED_CONNECT_REPORTS is "owner"/);
  });
  it('docs/hosted.md has the checklist', () => {
    const doc = readFileSync(join(__dirname, '../../docs/hosted.md'), 'utf8');
    expect(doc).toContain('### Going from owner to all');
    expect(doc).toMatch(/One real routed header inspected/);
  });
});
