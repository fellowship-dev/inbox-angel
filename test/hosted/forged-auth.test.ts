// The security review's blocker 1, through the real email() entry point: a forged report must not be counted as Google.
// The mail is the REAL Google report (test/fixtures/third-party/mox/google.eml, its From and report are untouched); only the receiver's
// Authentication-Results header is replaced with what a hostile sender could get a receiver to write by choosing its own mailfrom / HELO / comments.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { forWorkspace, resetSchemaReadyCache } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { generateToken, hashToken } from '../../src/hosted/tokens';
import { fakeMessage } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';
const ID = 'mx.cloudflare.net';
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const google = readFileSync(resolve(__dirname, '../fixtures/third-party/mox/google.eml'), 'utf8');
const AR_BLOCK = /^Authentication-Results: koriander\.ueber\.net;[\s\S]*?dkim-atps=neutral\r?\n/im;
const withAr = (header: string) => google.replace(AR_BLOCK, `Authentication-Results: ${header}\r\n`);
expect(google).toMatch(AR_BLOCK);

type World = Awaited<ReturnType<typeof twoWorkspaces>>;
async function own(w: World, domain: string) {
  const id = 100 + Math.floor(Math.random() * 1e6);
  w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (?, 'ws_a', ?, 'x')").run(id, domain);
  const token = generateToken();
  await forWorkspace(w.env.DB, 'ws_a').intake.set(id, await hashToken(token), NOW);
  return token;
}
/** The last structured intake line, in call order (accepted lines go to console.log, refused ones to console.warn). */
const log = () => {
  const calls = [console.log, console.warn].flatMap((f: any) => f.mock.calls.map((c: any[], i: number) => ({ line: String(c[0]), order: f.mock.invocationCallOrder[i] })));
  return calls.filter((c) => c.line.startsWith('{"evt":"intake"')).sort((x, y) => x.order - y.order).map((c) => JSON.parse(c.line)).at(-1);
};
async function deliver(w: World, token: string, eml: string) {
  resetSchemaReadyCache();
  const m = fakeMessage(`rua+${token}@${RUA}`, eml, { from: 'noreply-dmarc-support@google.com', headers: {} });
  await worker.email(m, { ...w.env, AUTHSERV_ID: ID, AUTHSERV_HEADER: 'ar' } as any, ctx);
  return m;
}
const rows = (w: World) => w.rows('SELECT reporter_tier t, reporter_identity i, reporter_known_as k, reporter_auth a, reporter_auth_reason r FROM aggregate_reports ORDER BY id');

const FORGED_1 = `${ID}; dkim=pass header.d=attacker.example header.i=@attacker.example header.s=s1 header.b=abc; dmarc=fail header.from=google.com; spf=pass (${ID}: domain of "x dkim=pass header.d=google.com y"@attacker.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@attacker.example; arc=none`;
const FORGED_2 = `${ID}; dkim=pass header.d=attacker.example; dmarc=fail header.from=google.com; spf=pass smtp.mailfrom="x dkim=pass header.d=google.com y"@attacker.example`;
const FORGED_3 = `${ID};\r\n\tdkim=pass header.d=attacker.example header.i=@attacker.example header.s=s1 header.b=abc;\r\n\tdmarc=fail header.from=google.com;\r\n\tspf=pass (${ID}: domain of "x dkim=pass header.d=google.com y"@attacker.example designates 192.0.2.1 as permitted sender) smtp.mailfrom="x dkim=pass header.d=google.com y"@attacker.example smtp.helo=attacker.example;\r\n\tarc=none`;

describe('forged Authentication-Results never count as Google', () => {
  it.each([['comment + quoted mailfrom, a later dkim clause', FORGED_1], ['quoted mailfrom only', FORGED_2], ['realistic folded variant', FORGED_3]])(
    '%s: stored as unauthenticated (the DKIM pass is for attacker.example, not the From organisation), not counted',
    async (_n, header) => {
      const w = await twoWorkspaces();
      const token = await own(w, 'ueber.net');
      await deliver(w, token, withAr(header));
      expect(rows(w)).toEqual([{ t: 'unauthenticated', i: '~unauth', k: null, a: 'fail', r: 'not_authenticated' }]);
      expect(log()).toMatchObject({ tier: 'unauthenticated', outcome: 'accepted' });
      expect(w.rows("SELECT COUNT(*) n FROM aggregate_reports WHERE reporter_tier = 'counted'")).toEqual([{ n: 0 }]);
    },
  );

  it('the same header with an UNQUOTED mailfrom shows the sender cannot add a method: still not google', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    await deliver(w, token, withAr(`${ID}; dkim=pass header.d=attacker.example; spf=pass smtp.mailfrom=x@attacker.example header.d=google.com`));
    expect(rows(w)[0]).toMatchObject({ t: 'unauthenticated' });
  });
});

describe('a genuine google.com signature stays counted', () => {
  const sig = 'dkim=pass (2048-bit key; unprotected) header.d=google.com header.i=@google.com header.b=RNB1nVFh';
  it('the real header as received (one signature, then dkim-atps)', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    await deliver(w, token, google.replace('Authentication-Results: koriander.ueber.net;', `Authentication-Results: ${ID};`));
    expect(rows(w)).toEqual([{ t: 'counted', i: 'google', k: 'Google', a: 'pass', r: null }]);
  });
  it.each([
    ['google.com first, then the 1e100.net signature result', `${ID}; ${sig}; dkim=pass (2048-bit key) header.d=1e100.net header.i=@1e100.net header.b=cp7PlYOs`],
    ['1e100.net first, then google.com', `${ID}; dkim=pass header.d=1e100.net header.b=cp7PlYOs; ${sig}`],
    ['google.com pass then a failing 1e100.net', `${ID}; ${sig}; dkim=fail header.d=1e100.net`],
  ])('%s', async (_n, header) => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    // Two dkim results come from two signatures (google.com and 1e100.net): the message carries both, as Google's mail does.
    const twoSignatures = withAr(header).replace(/^DKIM-Signature:/im, 'DKIM-Signature: v=1; a=rsa-sha256; d=1e100.net; s=20230601; bh=x; b=x\r\nDKIM-Signature:');
    await deliver(w, token, twoSignatures);
    expect(rows(w)).toEqual([{ t: 'counted', i: 'google', k: 'Google', a: 'pass', r: null }]);
    expect(log()).toMatchObject({ tier: 'counted', reporter: 'google', dkim_org: 'google.com' });
  });
});

describe('a header the tokenizer cannot read fails closed, with the reason stored', () => {
  it.each([
    ['unbalanced quote', `${ID}; dkim=pass header.d=google.com; spf=pass smtp.mailfrom="x@y`, 'authres_malformed'],
    ['unbalanced parenthesis', `${ID}; dkim=pass header.d=google.com (unclosed`, 'authres_malformed'],
    ['version 2', `${ID} 2; dkim=pass header.d=google.com`, 'authres_version_unsupported'],
    ['too long', `${ID}; dkim=pass header.d=google.com (${'x'.repeat(9000)})`, 'authres_too_long'],
    ['duplicate property', `${ID}; dkim=pass header.d=google.com header.d=google.com`, 'authres_malformed'],
  ])('%s', async (_n, header, reason) => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    await deliver(w, token, withAr(header));
    expect(rows(w)).toEqual([{ t: 'unauthenticated', i: '~unauth', k: null, a: 'fail', r: reason }]);
  });

  it('version 1 after the authserv-id is accepted', async () => {
    const w = await twoWorkspaces();
    const token = await own(w, 'ueber.net');
    await deliver(w, token, withAr(`${ID} 1; dkim=pass header.d=google.com`));
    expect(rows(w)[0]).toMatchObject({ t: 'counted', i: 'google' });
  });
});
