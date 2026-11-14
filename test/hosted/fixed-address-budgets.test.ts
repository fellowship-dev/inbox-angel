// The fixed address (rua@<INTAKE_DOMAIN>) on PR 151's intake: its order of work, the unattributed budget it charges before anything
// is decompressed, and that mail for domains nobody connected can never use up a workspace's or the instance's own budgets.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { handleHostedEmail } from '../../src/hosted/intake';
import { intakeSetupFindings } from '../../src/reports/auth-status';
import { dmarcXml, fakeMessage, gzipReportMime, mimeWithAttachment } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const RUA = 'rua.readysetmail.com';
const FIXED = `rua@${RUA}`;
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function world(extra: Record<string, string> = {}) {
  const w = await twoWorkspaces({ HOSTED_CONNECT_REPORTS: 'all', ...extra });
  w.db.sqlite.prepare("UPDATE domains SET rua_address = ?, verified_via = 'txt', reports_connected_at = 1 WHERE id = 1").run(FIXED); // a-corp.com, connected
  const send = async (domain: string, id: string, opts: Parameters<typeof fakeMessage>[2] = {}) => {
    const m = fakeMessage(FIXED, gzipReportMime(dmarcXml(domain, id)), opts);
    await handleHostedEmail(m, w.env);
    return m;
  };
  const quota = () => w.rows('SELECT scope, messages FROM intake_quota ORDER BY scope') as Array<{ scope: string; messages: number }>;
  return { ...w, send, quota };
}

describe('order of work on the fixed address', () => {
  it('mail for a domain nobody connected is refused after the peek, charged only to the unattributed budget', async () => {
    const w = await world();
    const m = await w.send('nobody.example', 'n1', { from: 'x@flood.example' });
    expect(m.setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    // One peek against this minute's ceiling, then (attribution failed) the unattributed budget; nothing else.
    expect(w.quota().map((q) => q.scope).filter((s) => !s.startsWith('f:peek:'))).toEqual(['f:s:u:flood.example', 'f:unauthenticated']);
    expect(w.quota().filter((q) => q.scope.startsWith('f:peek:')).map((q) => q.messages)).toEqual([1]);
    expect(w.rows('SELECT * FROM intake_usage')).toEqual([]);
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('a connected domain\'s report then goes through PR 151\'s caps (chargeIntakeCaps), tiers and store, exactly like a token address', async () => {
    const w = await world();
    expect((await w.send('a-corp.com', 'g1', GOOGLE)).setReject).not.toHaveBeenCalled();
    expect((await w.send('a-corp.com', 'u1', { from: 'x@flood.example' })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id, reporter_tier FROM aggregate_reports ORDER BY id')).toEqual([{ report_id: 'google|g1', reporter_tier: 'counted' }, { report_id: '~unauth|u1', reporter_tier: 'unauthenticated' }]);
    const scopes = w.quota().map((q) => q.scope);
    expect(scopes).toEqual(expect.arrayContaining(['a:1', 'w:ws_a', '*', 'u:1', 'n:ws_a', 'n:*']));
    // Mail for a connected domain is never charged the unattributed budget (only mail that fails attribution is), and registry mail takes no peek slot.
    expect(scopes.filter((s) => s.startsWith('f:') && !s.startsWith('f:peek:'))).toEqual([]);
    expect(w.quota().filter((q) => q.scope.startsWith('f:peek:')).map((q) => q.messages)).toEqual([1]);
  });

  it('a sender over its unattributed allowance: its mail for unconnected domains says so; its mail for a connected domain still arrives; a bomb costs one bounded peek', async () => {
    const w = await world({ INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY: '1' });
    expect((await w.send('nobody.example', 'n1', { from: 'x@flood.example' })).setReject).toHaveBeenCalledWith('Report is for a domain whose reports are not connected to this address');
    expect((await w.send('nobody.example', 'n2', { from: 'x@flood.example' })).setReject).toHaveBeenCalledWith('Daily intake limit for this sender reached; try again tomorrow');
    expect((await w.send('a-corp.com', 'connected', { from: 'x@flood.example' })).setReject).not.toHaveBeenCalled();
    const bomb = gzipSync(new Uint8Array(24 * 1024 * 1024).fill(0x20), { level: 9 });
    const m = fakeMessage(FIXED, mimeWithAttachment(bomb, 'r.xml.gz', 'application/gzip'), { from: 'x@flood.example' });
    const t0 = performance.now();
    await handleHostedEmail(m, w.env);
    expect(m.setReject).toHaveBeenCalledWith('The report does not name the domain it is about');
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

describe('a flood of mail for unconnected domains cannot exhaust anyone else\'s budget', () => {
  it('it fills only the unattributed budget; the instance\'s uncounted budget is untouched and counted reports still arrive', async () => {
    const w = await world({ INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY: '5', INTAKE_MAX_UNATTRIBUTED_PER_SENDER_PER_DAY: '100', INTAKE_MAX_UNCOUNTED_INSTANCE_MESSAGES_PER_DAY: '5' });
    for (let i = 0; i < 12; i++) await w.send(`victim${i}.example`, `f${i}`, { from: `x@flood${i}.example` });
    const total = w.quota().find((q) => q.scope === 'f:unauthenticated');
    expect(total?.messages).toBe(5); // full, and no further
    expect(w.quota().some((q) => q.scope === 'n:*' || q.scope.startsWith('n:') || q.scope.startsWith('u:'))).toBe(false); // the instance's uncounted budget: never charged
    // A known reporter (Google) for a connected domain is unaffected; so is a token address (it never uses the unattributed budget).
    expect((await w.send('a-corp.com', 'after-flood', GOOGLE)).setReject).not.toHaveBeenCalled();
    const tok = fakeMessage(`rua+${w.tokenB}@${RUA}`, gzipReportMime(dmarcXml('b-corp.org', 'token-after-flood')), { from: 'x@other.example' });
    await handleHostedEmail(tok, w.env);
    expect(tok.setReject).not.toHaveBeenCalled();
    // The owner's setup check names the unattributed cap.
    const findings = await intakeSetupFindings(w.env as any);
    expect(findings.some((f) => f.setting.includes('INTAKE_MAX_UNATTRIBUTED_MESSAGES_PER_DAY'))).toBe(true);
  });
});

describe('the residual forged header through the fixed address', () => {
  it('a receiver header split by an unquoted envelope sender is not believed: the report is stored uncounted', async () => {
    const w = await world();
    const envelope = 'x;dkim=pass header.d=google.com;arc=none smtp.x=y@attacker.example';
    const m = await w.send('a-corp.com', 'forged', { from: envelope, headers: { 'authentication-results': `mx.cloudflare.net; spf=pass smtp.mailfrom=${envelope}` } });
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reporter_tier, reporter_auth_reason FROM aggregate_reports')).toEqual([{ reporter_tier: 'unauthenticated', reporter_auth_reason: 'authres_malformed' }]);
  });
});

describe('uncounted caps reach the owner\'s setup check', () => {
  it('a workspace over its uncounted daily limit is named with its setting', async () => {
    const w = await world({ INTAKE_MAX_UNCOUNTED_WORKSPACE_MESSAGES_PER_DAY: '1' });
    expect((await w.send('a-corp.com', 'u1', { from: 'x@a.example' })).setReject).not.toHaveBeenCalled();
    expect((await w.send('a-corp.com', 'u2', { from: 'x@b.example' })).setReject).toHaveBeenCalledOnce();
    const findings = await intakeSetupFindings(w.env as any);
    expect(findings.some((f) => f.setting.includes('INTAKE_MAX_UNCOUNTED_WORKSPACE_MESSAGES_PER_DAY'))).toBe(true);
  });
});
