// Finding 7: the sender-written org_name, report email and From address are capped (64) and cleaned of control characters before they reach the
// intake_reporter_candidate log line or the candidates list (aggregate and route).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { senderText, SENDER_TEXT_MAX } from '../../src/hosted/intake-log';
import { handleUnknownReporterRoutes } from '../../src/reports/unknown-reporters';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const RUA = 'rua.readysetmail.com';

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('senderText', () => {
  it('drops control characters, bidi controls and line separators, collapses whitespace, caps at 64', () => {
    expect(senderText('a\u0000b\u001b[31mc\u007fd\u0085e\u202ef\u2028g\r\nh\t i')).toBe('a b [31mc d e f g h i');
    expect(senderText('  spaced   out  ')).toBe('spaced out');
    expect(senderText('x'.repeat(500))).toHaveLength(SENDER_TEXT_MAX);
    expect(SENDER_TEXT_MAX).toBe(64);
    expect(senderText(null)).toBe('');
  });
});

describe('through email(): an authenticated sender that is not in the registry writes hostile text', () => {
  const hostile = async () => {
    const w = await twoWorkspaces();
    const org = 'evil.example';
    const xml = dmarcXml('a-corp.com', 'h1', org)
      .replace(`<org_name>${org}</org_name>`, `<org_name>Evil\nCorp\u202e\u2028${'x'.repeat(150)}</org_name>`)
      .replace(`noreply-dmarc-support@${org}`, `no\u202ereply-${'y'.repeat(100)}@${org}`);
    const eml = gzipReportMime(xml).replace('From: noreply-dmarc-support@google.com', `From: noreply-dmarc-support@${org}`);
    const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, eml, { from: `noreply-dmarc-support@${org}`, headers: { 'authentication-results': `mx.cloudflare.net; dkim=pass header.d=${org} header.s=s1` } });
    await worker.email(m, w.env as any, ctx);
    return { w, m };
  };

  it('the candidate log line and the stored candidate are capped at 64 and free of control characters', async () => {
    const { w, m } = await hostile();
    expect(m.setReject).not.toHaveBeenCalled();
    const line = (console.log as any).mock.calls.map((c: any[]) => String(c[0])).find((l: string) => l.includes('intake_reporter_candidate'));
    const c = JSON.parse(line);
    for (const k of ['org_name', 'report_email', 'from']) {
      expect(c[k].length, k).toBeLessThanOrEqual(64);
      expect(c[k], k).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/);
    }
    expect(c.org_name).toMatch(/^evil corp /i);
    const row = w.rows('SELECT from_address, report_email, org_name FROM reporter_candidate_days')[0];
    for (const v of Object.values(row) as string[]) {
      expect(v.length).toBeLessThanOrEqual(64);
      expect(v).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/);
    }
  });

  it('the candidates route cleans rows again on the way out (rows an older build stored uncleaned)', async () => {
    const { w } = await hostile();
    w.db.sqlite.prepare("INSERT INTO reporter_candidate_days (dkim_org, from_address, report_email, workspace_id, day, reports, org_name) VALUES ('old.example', 'a@old.example', ?, 'ws_a', '2026-11-01', 1, ?)")
      .run('x\u001b[2Jy@old.example' + 'z'.repeat(200), 'Line1\nLine2\u202e' + 'q'.repeat(300));
    const res = await handleUnknownReporterRoutes(new Request('https://x.example/api/instance/reporter-candidates'), w.env as any, true);
    const body = await res!.json() as any;
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of body.candidates) {
      for (const k of ['dkim_org', 'from_address', 'report_email', 'org_name']) {
        expect((c[k] ?? '').length, k).toBeLessThanOrEqual(64);
        expect(c[k] ?? '', k).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/);
      }
    }
    expect(body.candidates.find((c: any) => c.dkim_org === 'old.example').org_name).toMatch(/^Line1 Line2 /);
  });
});
