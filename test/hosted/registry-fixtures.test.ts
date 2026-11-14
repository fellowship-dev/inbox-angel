// The known-reporter registry against REAL receiver mail (test/fixtures/third-party, see test/fixtures/THIRD_PARTY.md), through the real
// email() entry point. The fixtures were received by other servers, so where a test needs the carrier to look authenticated only the
// Authentication-Results header is touched, and each test says how:
//   `retarget`  the topmost header's authserv-id (the receiver's own name in the file) becomes the test's AUTHSERV_ID. Nothing else is changed:
//               the dkim=pass result and header.d= are the ones the original receiver wrote.
//   `inject`    the file's headers were stripped upstream, so a header is ADDED (what Cloudflare would have written for a signed message).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { forWorkspace, resetSchemaReadyCache } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { generateToken, hashToken } from '../../src/hosted/tokens';
import { KNOWN_REPORTERS } from '../../src/dmarc/known-reporters';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';
const ID = 'mx.cloudflare.net';
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const fixture = (p: string) => readFileSync(resolve(__dirname, '../fixtures/third-party', p), 'utf8');
const retarget = (eml: string, from: string) => eml.replace(`Authentication-Results: ${from};`, `Authentication-Results: ${ID};`);
const inject = (eml: string, results: string) => `Authentication-Results: ${ID}; ${results}\r\n${eml}`;
const fromOf = (eml: string) => /^From: (?:.*<)?([^>\r\n]+?)>?\s*$/im.exec(eml)![1].trim();

type World = Awaited<ReturnType<typeof twoWorkspaces>>;
async function own(w: World, domain: string) {
  const id = 100 + Math.floor(Math.random() * 1e6);
  w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, 'ws_a', ?, 'x')").run(id, domain);
  const token = generateToken();
  await forWorkspace(w.env.DB, 'ws_a').intake.set(id, await hashToken(token), NOW);
  return token;
}
const log = () => [...(console.log as any).mock.calls, ...(console.warn as any).mock.calls].map((c: any[]) => String(c[0])).filter((l: string) => l.startsWith('{"evt":"intake"')).map((l: string) => JSON.parse(l)).at(-1);
async function deliver(w: World, token: string, eml: string, env: Record<string, string> = {}) {
  resetSchemaReadyCache();
  const m = fakeMessage(`rua+${token}@${RUA}`, eml, { from: fromOf(eml), headers: {} });
  await worker.email(m, { ...w.env, ...env } as any, ctx);
  return m;
}
const tiers = (w: World) => w.rows('SELECT reporter_tier t, reporter_identity i, reporter_known_as k FROM aggregate_reports ORDER BY id');

describe('registry entries match the real reports that are the evidence for them', () => {
  const cases: Array<{ name: string; file: string; domain: string; prepare: (e: string) => string; identity: string; label: string; dkimOrg: string }> = [
    { name: 'Google', file: 'mox/google.eml', domain: 'ueber.net', prepare: (e) => retarget(e, 'koriander.ueber.net'), identity: 'google', label: 'Google', dkimOrg: 'google.com' },
    { name: 'Microsoft (DKIM d=notification.microsoft.com, From microsoft.com)', file: 'mox/outlook.eml', domain: 'ueber.net', prepare: (e) => retarget(e, 'koriander.ueber.net'), identity: 'microsoft', label: 'Microsoft', dkimOrg: 'microsoft.com' },
    { name: 'Yahoo 2019 (postmaster@dmarc.yahoo.com)', file: 'mox/yahoo.eml', domain: 'ueber.net', prepare: (e) => retarget(e, 'koriander.ueber.net'), identity: 'yahoo', label: 'Yahoo (and AOL)', dkimOrg: 'yahoo.com' },
    { name: 'Mail.ru', file: 'mox/mailru.eml', domain: 'ueber.net', prepare: (e) => retarget(e, 'koriander.ueber.net'), identity: 'mailru', label: 'Mail.ru', dkimOrg: 'mail.ru' },
    { name: 'XS4ALL', file: 'mox/xs4all.eml', domain: 'ueber.net', prepare: (e) => retarget(e, 'koriander.ueber.net'), identity: 'xs4all', label: 'XS4ALL', dkimOrg: 'xs4all.net' },
    { name: 'Yahoo 2023 (dmarchelp@yahooinc.com; headers stripped upstream, header injected)', file: 'freitagsrunde/yahoo.eml', domain: 'freitagsrunde.org', prepare: (e) => inject(e, 'dkim=pass header.d=yahoo.com'), identity: 'yahoo', label: 'Yahoo (and AOL)', dkimOrg: 'yahoo.com' },
    { name: 'AOL via Yahoo (Submitter aol.com; header injected)', file: 'freitagsrunde/aol.eml', domain: 'freitagsrunde.org', prepare: (e) => inject(e, 'dkim=pass header.d=yahoo.com'), identity: 'yahoo', label: 'Yahoo (and AOL)', dkimOrg: 'yahoo.com' },
    { name: 'Fastmail (DKIM domain NOT observed upstream: header injected, see the registry caveat)', file: 'freitagsrunde/fastmail.eml', domain: 'freitagsrunde.org', prepare: (e) => inject(e, 'dkim=pass header.d=fastmaildmarc.com'), identity: 'fastmail', label: 'Fastmail', dkimOrg: 'fastmaildmarc.com' },
  ];

  it.each(cases)('$name is counted, stored with its identity, and logged', async (c) => {
    const w = await twoWorkspaces();
    const token = await own(w, c.domain);
    const m = await deliver(w, token, c.prepare(fixture(c.file)));
    expect(m.setReject).not.toHaveBeenCalled();
    expect(tiers(w)).toEqual([{ t: 'counted', i: c.identity, k: c.label }]);
    expect(log()).toMatchObject({ outcome: 'accepted', tier: 'counted', reporter: c.identity, dkim_org: c.dkimOrg, email_matched: true, dedup: 'new' });
  });

  it('every registry entry has evidence, and each id above is a real entry', () => {
    for (const e of KNOWN_REPORTERS) expect(e.evidence.length, e.id).toBeGreaterThan(0);
    for (const c of cases) expect(KNOWN_REPORTERS.some((e) => e.id === c.identity), c.identity).toBe(true);
  });
});

describe('the same real reports are NOT counted when they are not authenticated as the reporter', () => {
  it('the Google report with no Authentication-Results at all is stored as unauthenticated, never counted', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    const eml = fixture('mox/google.eml').replace(/^Authentication-Results: koriander\.ueber\.net;[\s\S]*?dkim-atps=neutral\r?\n/im, '');
    expect(eml).not.toMatch(/^Authentication-Results:/im);
    await deliver(w, token, eml);
    expect(tiers(w)).toEqual([{ t: 'unauthenticated', i: '~unauth', k: null }]);
    expect(log()).toMatchObject({ tier: 'unauthenticated', outcome: 'accepted' });
    expect(w.rows('SELECT reporter_auth_reason r FROM aggregate_reports')).toEqual([{ r: 'no_authentication_results' }]);
  });

  it('a header naming another authserv-id (the file as received, "koriander.ueber.net") proves nothing here', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    await deliver(w, token, fixture('mox/google.eml'));
    expect(tiers(w)).toEqual([{ t: 'unauthenticated', i: '~unauth', k: null }]);
    expect(log()).toMatchObject({ tier: 'unauthenticated', outcome: 'accepted' });
    expect(w.rows('SELECT reporter_auth_reason r FROM aggregate_reports')).toEqual([{ r: 'authserv_id_not_found' }]);
  });

  it('Yahoo\'s report with another yahoo.com mailbox as From is not counted as Yahoo: wrong From for the signing organisation', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    const eml = retarget(fixture('mox/yahoo.eml'), 'koriander.ueber.net').replace('From: noreply@dmarc.yahoo.com', 'From: someone@yahoo.com');
    await deliver(w, token, eml);
    expect(tiers(w)[0]).toMatchObject({ t: 'unknown', k: null });
    expect(log()).toMatchObject({ tier: 'unknown', email_matched: null }); // no registry entry matched DKIM org + From, so no report email was even compared
  });

  // Mimecast. The security review found the registry entry said "unconfirmed" while the fixture test accepted `counted`. The sample's XML DOES extract with the
  // hardened extractor and its report_metadata/email is no-reply@au-1.mimecastreport.com, so the entry now lists exactly the observed region (au-1) and the
  // caveat about an unseen report email is gone; every other Mimecast region is stored as unknown until confirmed. The file's own Authentication-Results is
  // Microsoft's (nonstandard `action=none`, `compauth=pass reason=100`), which the RFC 8601 tokenizer correctly refuses: the header Cloudflare would have written
  // for the same DKIM result is injected instead.
  const mimecast = () => {
    const stripped = fixture('parsedmarc/mimecast-weird-gzip.eml').replace(/^Authentication-Results:[\s\S]*?compauth=pass reason=100\r?\n/im, '');
    expect(stripped).not.toMatch(/^Authentication-Results:/im);
    return inject(stripped, 'spf=pass smtp.mailfrom=au-1.mimecastreport.com; dkim=pass header.d=au-1.mimecastreport.com; dmarc=pass header.from=au-1.mimecastreport.com');
  };

  it('the real Mimecast sample is counted, as the registry entry says (entry and test agree: no unconfirmed caveat left)', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ab.id.au');
    const m = await deliver(w, token, mimecast());
    expect(m.setReject).not.toHaveBeenCalled();
    expect(tiers(w)).toEqual([{ t: 'counted', i: 'mimecast', k: 'Mimecast' }]);
    expect(log()).toMatchObject({ outcome: 'accepted', tier: 'counted', reporter: 'mimecast', dkim_org: 'mimecastreport.com', email_matched: true });
    const entry = KNOWN_REPORTERS.find((e) => e.id === 'mimecast')!;
    expect(entry.reportEmails).toEqual(['no-reply@au-1.mimecastreport.com']);
    expect(entry.caveat ?? '').not.toMatch(/confirm on the first live report|could not be extracted/);
  });

  it('the same carrier from a region that was never observed (us-1) is stored as unknown, not counted', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ab.id.au');
    const eml = mimecast().replaceAll('au-1.mimecastreport.com', 'us-1.mimecastreport.com');
    const m = await deliver(w, token, eml);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(tiers(w)).toEqual([{ t: 'unknown', i: 'mimecastreport.com', k: null }]);
  });
});
