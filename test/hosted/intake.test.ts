import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { intakeLookups, forAccount, resetSchemaReadyCache } from '@inbox-angel/db';
import { createTestD1 } from '@inbox-angel/db/testing';
import worker from '../../src/index';
import { handleHostedEmail } from '../../src/hosted/intake';
import { coversDomain } from '../../src/hosted/scope';
import { generateToken, hashToken, intakeAddress, isTokenShaped, parseRecipient } from '../../src/hosted/tokens';
import { resolveInboundAccount } from '../../src/tenancy/resolver';
import { dmarcXml, fakeMessage, gzipReportMime, mimeWithAttachment, tlsRptJson, tlsRptMime, zipReportMime } from '../helpers/mail';
import { NOW, nxdomain, quiet, twoAccounts } from './world';

// cloudflare:email only exists in workerd.
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.inboxangel.io';

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Building, gzipping and inflating ~26 MiB took ~6 s under load against the 5 s default. The assertions stay as they are. */
const BIG_REPORT_TIMEOUT = 30_000;

describe('tokens', () => {
  it('are at least 128 bits, random, lowercase base32 and survive a + sub-address', () => {
    const t = generateToken();
    expect(t).toMatch(/^[a-z2-7]{32}$/); // 32 × 5 bits = 160
    expect(generateToken()).not.toBe(t);
    expect(isTokenShaped(t)).toBe(true);
    expect(isTokenShaped('short')).toBe(false);
    expect(parseRecipient(intakeAddress('rua', t, RUA))).toEqual({ base: 'rua', tag: t, host: RUA });
    expect(parseRecipient(`RUA+${t.toUpperCase()}@RUA.InboxAngel.io`)).toEqual({ base: 'rua', tag: t, host: RUA });
    expect(parseRecipient('rua@rua.inboxangel.io')).toEqual({ base: 'rua', host: RUA });
  });

  it('resolve to account + domain; only the hash is stored', async () => {
    const w = await twoAccounts();
    const look = intakeLookups(w.env.DB);
    expect(await look.resolveToken(await hashToken(w.tokenA), NOW)).toEqual({ account_id: 'acct_a', domain_id: 1, domain: 'a-corp.com' });
    expect(await look.resolveToken(await hashToken(w.tokenB), NOW)).toEqual({ account_id: 'acct_b', domain_id: 2, domain: 'b-corp.org' });
    expect(await look.resolveToken(await hashToken(generateToken()), NOW)).toBeNull();
    expect(JSON.stringify(w.rows('SELECT * FROM intake_tokens'))).not.toContain(w.tokenA);
  });

  it('rotate: the new token works at once, the old one only for the grace period', async () => {
    const w = await twoAccounts();
    const look = intakeLookups(w.env.DB);
    const fresh = generateToken();
    await forAccount(w.env.DB, 'acct_a').intake.set(1, await hashToken(fresh), NOW + 100);
    expect((await look.resolveToken(await hashToken(fresh), NOW + 101))?.account_id).toBe('acct_a');
    expect((await look.resolveToken(await hashToken(w.tokenA), NOW + 101))?.account_id).toBe('acct_a'); // grace
    expect(await look.resolveToken(await hashToken(w.tokenA), NOW + 100 + 72 * 3600 + 1)).toBeNull(); // expired
    expect((await look.resolveToken(await hashToken(fresh), NOW + 100 + 72 * 3600 + 1))?.account_id).toBe('acct_a');
  });
});

describe('DMARC aggregate reports', () => {
  it('are routed to the account the token belongs to', async () => {
    const w = await twoAccounts();
    const a = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com', 'ra')));
    const b = fakeMessage(`rua+${w.tokenB}@${RUA}`, zipReportMime(dmarcXml('b-corp.org', 'rb')));
    await handleHostedEmail(a, w.env);
    await handleHostedEmail(b, w.env);
    expect(a.setReject).not.toHaveBeenCalled();
    expect(b.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT account_id, domain_id, report_id FROM aggregate_reports ORDER BY domain_id')).toEqual([
      { account_id: 'acct_a', domain_id: 1, report_id: 'ra' },
      { account_id: 'acct_b', domain_id: 2, report_id: 'rb' },
    ]);
    expect(w.rows('SELECT DISTINCT account_id FROM report_records ORDER BY 1').map(r => r.account_id)).toEqual(['acct_a', 'acct_b']);
  });

  it('a report for a domain the token’s account does not own is rejected for good, and stored nowhere', async () => {
    const w = await twoAccounts();
    const spoof = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('b-corp.org', 'spoof')));
    await handleHostedEmail(spoof, w.env);
    expect(spoof.setReject).toHaveBeenCalledOnce();
    expect(spoof.setReject.mock.calls[0][0]).toMatch(/Unknown domain b-corp\.org/);
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith('[intake] rejected', expect.stringContaining('"account":"acct_a"'));
  });

  it('an unknown token is rejected with a logged reason, and never touches the database', async () => {
    const w = await twoAccounts();
    const m = fakeMessage(`rua+${generateToken()}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    await handleHostedEmail(m, w.env);
    expect(m.setReject).toHaveBeenCalledWith('Unknown intake token');
    expect(console.warn).toHaveBeenCalledWith('[intake] rejected', expect.stringContaining('Unknown intake token'));
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it.each([['no tag', `rua@${RUA}`], ['a malformed token', `rua+nope@${RUA}`], ['an unknown base address', `postmaster+x@${RUA}`], ['a foreign host', 'rua+x@reports.acme.com']])('%s is rejected', async (_n, to) => {
    const w = await twoAccounts();
    const m = fakeMessage(to, gzipReportMime(dmarcXml('a-corp.com')));
    await handleHostedEmail(m, w.env);
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('malformed attachments are rejected, not stored', async () => {
    const w = await twoAccounts();
    for (const raw of [
      mimeWithAttachment(strToU8('this is not a report'), 'r.xml.gz', 'application/gzip'),
      mimeWithAttachment(new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]), 'r.xml.gz', 'application/gzip'),
      mimeWithAttachment(strToU8('<?xml version="1.0"?><feedback><oops/></feedback>'), 'r.xml', 'text/xml'),
      'Subject: no attachment at all\r\n\r\njust text',
    ]) {
      const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, raw);
      await handleHostedEmail(m, w.env);
      expect(m.setReject).toHaveBeenCalledOnce();
    }
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('caps reports at 25 MiB: a small gzip that inflates past it, and an oversized message, are rejected', async () => {
    const w = await twoAccounts();
    const bomb = '<?xml version="1.0"?><feedback>' + ' '.repeat(26 * 1024 * 1024) + '</feedback>';
    const compressed = gzipSync(strToU8(bomb));
    expect(compressed.length).toBeLessThan(200_000);
    const m1 = fakeMessage(`rua+${w.tokenA}@${RUA}`, mimeWithAttachment(compressed, 'r.xml.gz', 'application/gzip'));
    await handleHostedEmail(m1, w.env);
    expect(m1.setReject.mock.calls[0][0]).toMatch(/larger than/);

    const m2 = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')), { rawSize: 26 * 1024 * 1024 });
    await handleHostedEmail(m2, w.env);
    expect(m2.setReject).toHaveBeenCalledWith('Report is larger than 25 MiB');
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  }, BIG_REPORT_TIMEOUT);

  it('accepts a report just under the cap', async () => {
    const w = await twoAccounts();
    const big = dmarcXml('a-corp.com', 'big').replace('</feedback>', '<!--' + 'x'.repeat(20 * 1024 * 1024) + '--></feedback>');
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, mimeWithAttachment(gzipSync(strToU8(big)), 'r.xml.gz', 'application/gzip'));
    await handleHostedEmail(m, w.env);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT report_id FROM aggregate_reports')).toEqual([{ report_id: 'big' }]);
  }, BIG_REPORT_TIMEOUT);
});

describe('what a token may file', () => {
  it('coversDomain: the domain and its subdomains only', () => {
    expect(coversDomain('a-corp.com', 'a-corp.com')).toBe(true);
    expect(coversDomain('a-corp.com', 'Mail.Eu.A-Corp.com.')).toBe(true);
    for (const other of ['corp.com', 'xa-corp.com', 'a-corp.com.evil.io', 'a-corp.org', 'com']) expect(coversDomain('a-corp.com', other)).toBe(false);
    expect(coversDomain('mail.a-corp.com', 'a-corp.com')).toBe(false); // a parent is wider than the token
    expect(coversDomain('co.uk', 'evil.co.uk')).toBe(false); // a public suffix never covers anything
  });

  it('DMARC for a subdomain is accepted and filed under the token’s domain', async () => {
    const w = await twoAccounts();
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('mail.a-corp.com', 'sub-1')));
    await handleHostedEmail(m, w.env);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT account_id, domain_id, report_id FROM aggregate_reports')).toEqual([{ account_id: 'acct_a', domain_id: 1, report_id: 'sub-1' }]);
  });

  it('domain A’s token cannot file for domain B of the same account, nor for a parent', async () => {
    const w = await twoAccounts();
    w.db.sqlite.prepare("INSERT INTO domains (id, account_id, domain, rua_address) VALUES (3, 'acct_a', 'a-other.com', 'x'), (4, 'acct_a', 'corp.com', 'x')").run();
    for (const domain of ['a-other.com', 'corp.com']) {
      const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml(domain, 'x-' + domain)));
      await handleHostedEmail(m, w.env);
      expect(m.setReject, domain).toHaveBeenCalledOnce();
    }
    const tls = fakeMessage(`tls-rpt+${w.tokenA}@${RUA}`, tlsRptMime(tlsRptJson('a-other.com')));
    await handleHostedEmail(tls, w.env);
    expect(tls.setReject).toHaveBeenCalledOnce();
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
    expect(w.rows('SELECT * FROM tls_reports')).toEqual([]);
  });

  it('TLS-RPT for the domain and a subdomain files as one row under the token’s domain', async () => {
    const w = await twoAccounts();
    const pol = (d: string) => ({ policy: { 'policy-type': 'sts', 'policy-domain': d }, summary: { 'total-successful-session-count': 4, 'total-failure-session-count': 1 } });
    const m = fakeMessage(`tls-rpt+${w.tokenA}@${RUA}`, tlsRptMime(tlsRptJson('a-corp.com', { policies: [pol('a-corp.com'), pol('mail.a-corp.com')] })));
    await handleHostedEmail(m, w.env);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT domain_id, total_success, total_failure FROM tls_reports')).toEqual([{ domain_id: 1, total_success: 8, total_failure: 2 }]);
  });
});

describe('TLS-RPT reports', () => {
  it('are stored under the token’s account, from a JSON body or a gzip attachment', async () => {
    const w = await twoAccounts();
    await handleHostedEmail(fakeMessage(`tls-rpt+${w.tokenA}@${RUA}`, tlsRptMime(tlsRptJson('a-corp.com'))), w.env);
    const gz = fakeMessage(`tls-rpt+${w.tokenB}@${RUA}`, tlsRptMime(tlsRptJson('b-corp.org'), true));
    await handleHostedEmail(gz, w.env);
    expect(gz.setReject).not.toHaveBeenCalled();
    expect(w.rows('SELECT account_id, domain_id, total_success, total_failure FROM tls_reports ORDER BY domain_id')).toEqual([
      { account_id: 'acct_a', domain_id: 1, total_success: 10, total_failure: 2 },
      { account_id: 'acct_b', domain_id: 2, total_success: 10, total_failure: 2 },
    ]);
  });

  it('a policy-domain the account does not own rejects the whole report', async () => {
    const w = await twoAccounts();
    const json = tlsRptJson('a-corp.com', { policies: [
      { policy: { 'policy-type': 'sts', 'policy-domain': 'a-corp.com' }, summary: { 'total-successful-session-count': 1, 'total-failure-session-count': 0 } },
      { policy: { 'policy-type': 'sts', 'policy-domain': 'b-corp.org' }, summary: { 'total-successful-session-count': 1, 'total-failure-session-count': 0 } },
    ] });
    const m = fakeMessage(`tls-rpt+${w.tokenA}@${RUA}`, tlsRptMime(json));
    await handleHostedEmail(m, w.env);
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(w.rows('SELECT * FROM tls_reports')).toEqual([]);
  });

  it.each([['not JSON', 'Subject: x\r\n\r\nhello'], ['no policies', JSON.stringify({ 'organization-name': 'x', policies: [] })]])('%s is rejected', async (_n, body) => {
    const w = await twoAccounts();
    const raw = body.startsWith('Subject') ? body : tlsRptMime(body);
    const m = fakeMessage(`tls-rpt+${w.tokenA}@${RUA}`, raw);
    await handleHostedEmail(m, w.env);
    expect(m.setReject).toHaveBeenCalledOnce();
    expect(w.rows('SELECT * FROM tls_reports')).toEqual([]);
  });

  it('a compressed report over the cap is rejected', async () => {
    const w = await twoAccounts();
    const huge = tlsRptJson('a-corp.com', { 'contact-info': 'x'.repeat(26 * 1024 * 1024) });
    const m = fakeMessage(`tls-rpt+${w.tokenA}@${RUA}`, tlsRptMime(huge, true));
    await handleHostedEmail(m, w.env);
    expect(m.setReject).toHaveBeenCalledWith('TLS-RPT report is too large');
  }, BIG_REPORT_TIMEOUT);
});

describe('saas has no default account', () => {
  it('resolveInboundAccount refuses to answer in saas and still answers in self-host', async () => {
    await expect(resolveInboundAccount({ MODE: 'saas' } as any, 'rua@x.io')).rejects.toThrow(/by token/);
    expect(await resolveInboundAccount({} as any, 'rua@reports.acme.com')).toBe('acct_default');
  });

  it('mail that carries no valid token is never filed under acct_default', async () => {
    const w = await twoAccounts();
    w.db.sqlite.prepare("INSERT INTO domains (id, account_id, domain, rua_address) VALUES (9, 'acct_default', 'a-corp.net', 'x')").run();
    for (const to of [`rua@${RUA}`, 'rua@reports.a-corp.net', `rua+${generateToken()}@${RUA}`]) {
      const m = fakeMessage(to, gzipReportMime(dmarcXml('a-corp.net')));
      await worker.email(m, w.env as any, ctx);
      expect(m.setReject).toHaveBeenCalledOnce();
    }
    expect(w.rows('SELECT * FROM aggregate_reports')).toEqual([]);
  });

  it('through the Worker entry point: delivered to the right account', async () => {
    const w = await twoAccounts();
    const m = fakeMessage(`rua+${w.tokenB}@${RUA}`, gzipReportMime(dmarcXml('b-corp.org', 'via-worker')));
    await worker.email(m, w.env as any, ctx);
    expect(w.rows('SELECT account_id, report_id FROM aggregate_reports')).toEqual([{ account_id: 'acct_b', report_id: 'via-worker' }]);
  });

  it('a database that is not migrated yet throws (the sender retries) instead of rejecting', async () => {
    const m = fakeMessage(`rua+${generateToken()}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    const env = { DB: createTestD1(), MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: RUA, CANARY_DOMAIN: 'canary.inboxangel.io' } as any;
    await expect(worker.email(m, env, ctx)).rejects.toThrow(/out of date/);
    expect(m.setReject).not.toHaveBeenCalled();
  });

  it('a deployment missing its hosted config throws too, rather than dropping mail', async () => {
    const w = await twoAccounts({ INTAKE_DOMAIN: '' });
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(dmarcXml('a-corp.com')));
    await expect(handleHostedEmail(m, w.env)).rejects.toThrow(/not configured/);
    expect(m.setReject).not.toHaveBeenCalled();
    const off = await twoAccounts({ SAAS_ENABLED: '' });
    await expect(handleHostedEmail(fakeMessage(`rua+${off.tokenA}@${RUA}`, 'x'), off.env)).rejects.toThrow(/not configured/);
  });
});
