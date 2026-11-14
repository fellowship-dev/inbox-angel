// The review's remaining points on the shared report address. Each block failed on main e4eed70.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { handleHostedEmail } from '../../src/hosted/intake';
import { tokenizeAuthResults } from '../../src/email/auth-results';
import { authProof, parseAuthResults } from '../../src/email/parse-headers';
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

const mime = (domain: string, id: string, from?: string) => {
  const m = gzipReportMime(dmarcXml(domain, id, from ? from.slice(from.lastIndexOf('@') + 1) : undefined));
  return from ? m.replace('From: noreply-dmarc-support@google.com', `From: ${from}`) : m;
};

async function world(extra: Record<string, string> = {}) {
  const w = await twoWorkspaces({ HOSTED_CONNECT_REPORTS: 'all', ...extra });
  w.db.sqlite.prepare("UPDATE domains SET rua_address = ?, verified_via = 'txt', reports_connected_at = 1 WHERE id = 1").run(FIXED); // a-corp.com, connected
  const send = async (domain: string, id: string, o: { envelope?: string; from?: string; ar?: string; dkimSignatures?: number } = {}) => {
    const m = fakeMessage(FIXED, mime(domain, id, o.from), { from: o.envelope ?? 'x@sender.example', headers: o.ar ? { 'authentication-results': o.ar } : {}, ...(o.dkimSignatures !== undefined ? { dkimSignatures: o.dkimSignatures } : {}) });
    await handleHostedEmail(m, w.env);
    return m;
  };
  const tiers = () => w.rows('SELECT reporter_tier FROM aggregate_reports ORDER BY id').map((r) => r.reporter_tier);
  return { ...w, send, tiers };
}

describe('1. past the peek ceiling: unauthenticated mail is refused, authenticated non-registry mail is deferred', () => {
  it('refuse, defer, and known reporters still go through', async () => {
    const w = await world({ INTAKE_MAX_FIXED_PEEKS_PER_MINUTE: '2' });
    for (let i = 0; i < 2; i++) await w.send(`victim${i}.example`, `p${i}`);
    const unauth = await w.send('a-corp.com', 'unauth');
    expect(unauth.setReject).toHaveBeenCalledWith('The service is not accepting reports from unauthenticated senders right now');
    await expect(w.send('a-corp.com', 'auth-unknown', { from: 'dmarc@small-isp.example', envelope: 'bounce@small-isp.example', ar: `${ID}; dkim=pass header.d=small-isp.example` })).rejects.toThrow(/busy/);
    const google = await w.send('a-corp.com', 'google', { envelope: 'noreply-dmarc-support@google.com', ar: `${ID}; dkim=pass header.d=google.com` });
    expect(google.setReject).not.toHaveBeenCalled();
    expect(w.tiers()).toEqual(['counted']);
  });
});

describe('2. an unauthenticated report is never labelled by the name it wrote', () => {
  it('by_reporter says "unverified sender", the claimed name only as `claims`', async () => {
    const w = await world();
    expect((await w.send('a-corp.com', 'forged-google')).setReject).not.toHaveBeenCalled(); // org_name google.com, not authenticated
    const tenant = await loadTenant(w.env, { workspaceId: 'ws_a' });
    const s = await reportAddressStatus(tenant, (await tenant.scope.domains.getById(1))!) as any;
    expect(s.visibility.uncounted.by_reporter).toEqual([{ reporter: 'unverified sender', reports: 1, unverified: true, claims: 'google.com' }]);
  });
});

describe('3. a Unicode-form IDN in a property value drops only that result', () => {
  it('the tokenizer keeps the rest of the header', () => {
    const t = tokenizeAuthResults(`${ID}; dkim=pass header.d=bücher.example; dkim=pass header.d=google.com; spf=pass smtp.mailfrom=bounce@exämple.test`);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.results.map((r) => [r.method, r.props['header.d'] ?? null])).toEqual([['dkim', 'google.com']]);
    expect(authProof(parseAuthResults(`${ID}; dkim=pass header.d=bücher.example; dkim=pass header.d=google.com`)).dkimPassOrgs).toEqual(['google.com']);
  });
  it('through the shared address: the genuine Google pass still counts', async () => {
    const w = await world();
    const m = await w.send('a-corp.com', 'idn', { envelope: 'noreply-dmarc-support@google.com', ar: `${ID}; dkim=pass header.d=bücher.example; dkim=pass header.d=google.com` });
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.tiers()).toEqual(['counted']);
  });
});

describe('4. a results header with more dkim results than the message has signatures is not believed', () => {
  const HELO = `${ID}; spf=pass smtp.helo=x;dkim=pass(c)header.d=google.com`;
  it('the reviewer\'s HELO written back unquoted, on an unsigned message: not counted as Google', async () => {
    const w = await world();
    expect((await w.send('a-corp.com', 'helo', { envelope: 'noreply-dmarc-support@google.com', ar: HELO, dkimSignatures: 0 })).setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT reporter_tier, reporter_auth_reason FROM aggregate_reports')).toEqual([{ reporter_tier: 'unauthenticated', reporter_auth_reason: 'authres_malformed' }]);
  });
  it('the same on a message the sender signed once with its own domain (one signature, two dkim results)', async () => {
    const w = await world();
    await w.send('a-corp.com', 'helo-signed', { envelope: 'noreply-dmarc-support@google.com', ar: `${ID}; dkim=pass header.d=attacker.example; spf=pass smtp.helo=x;dkim=pass(c)header.d=google.com`, dkimSignatures: 1 });
    expect(w.tiers()).toEqual(['unauthenticated']);
  });
  it('two dmarc results are not believed either', async () => {
    const w = await world();
    await w.send('a-corp.com', 'two-dmarc', { envelope: 'noreply-dmarc-support@google.com', ar: `${ID}; dkim=pass header.d=google.com; dmarc=pass header.from=google.com; dmarc=pass header.from=google.com` });
    expect(w.tiers()).toEqual(['unauthenticated']);
  });
  it('a genuine header with as many dkim results as signatures still counts ("none" results need no signature)', async () => {
    const w = await world();
    await w.send('a-corp.com', 'genuine', { envelope: 'noreply-dmarc-support@google.com', ar: `${ID}; dkim=pass header.d=google.com; dkim=none (no second signature)`, dkimSignatures: 1 });
    expect(w.tiers()).toEqual(['counted']);
  });
});

describe('4. docs: going from owner to all', () => {
  it('names the sender\'s view of a thrown handler, the HELO test, the routing rule and the wildcard authorisation record, and the HELO risk', () => {
    const doc = readFileSync(join(__dirname, '../../docs/hosted.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### Going from owner to all'));
    expect(section).toMatch(/what the sending server sees when the Worker throws/i);
    expect(section).toMatch(/HELO containing `;`/);
    expect(section).toMatch(/`rua@<INTAKE_DOMAIN>` routing rule/);
    expect(section).toMatch(/\*\._report\._dmarc\.<INTAKE_DOMAIN>/);
    expect(section).toMatch(/would be counted as the forged identity/);
  });
});
