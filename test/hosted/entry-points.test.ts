// The functions PR 150 (the single-address intake) calls, exercised directly: their documented contracts.
import { describe, it, expect } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { forWorkspace } from '@ready-set-mail/db';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { chargeIntakeCaps } from '../../src/hosted/intake';
import { intakeLimits } from '../../src/hosted/config';
import { authenticateCarrier } from '../../src/dmarc/reporter-auth';
import { extractReportCapped, ReportTooLargeError } from '../../src/dmarc/extract-report';
import { carrierFromHeaders } from '../../src/dmarc/reporter-auth';

const env = { MODE: 'saas', AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' };
const stream = (s: string) => new Response(s).body!;

describe('extractReportCapped', () => {
  it('returns the XML under the limit and refuses past it, by what is produced', () => {
    const xml = '<feedback>' + ' '.repeat(10_000) + '</feedback>';
    expect(extractReportCapped(gzipSync(strToU8(xml)), 20_000)).toBe(xml);
    expect(() => extractReportCapped(gzipSync(strToU8(xml)), 5_000)).toThrow(ReportTooLargeError);
  });
});

describe('authenticateCarrier', () => {
  it('classifies a raw message stream from its topmost authentication header', async () => {
    const raw = 'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=google.com\r\nDKIM-Signature: v=1; d=google.com; s=s; bh=x; b=x\r\nFrom: noreply-dmarc-support@google.com\r\n\r\nbody';
    const { carrier } = await authenticateCarrier(stream(raw), env);
    expect(carrier).toMatchObject({ class: 'registry', authenticated: true, dkimOrg: 'google.com' });
    expect((await authenticateCarrier(stream('From: a@b.example\r\n\r\nx'), env)).carrier).toMatchObject({ class: 'unauthenticated', reason: 'no_authentication_results' });
  });
});

describe('chargeIntakeCaps', () => {
  const setup = () => {
    const db = createMigratedD1();
    db.sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_a', 'a')").run();
    db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address) VALUES (1, 'ws_a', 'a.example', 'x')").run();
    return forWorkspace(db as unknown as D1Database, 'ws_a').intake;
  };
  const google = carrierFromHeaders({ ar: 'mx.cloudflare.net; dkim=pass header.d=google.com', arc: null, from: 'noreply-dmarc-support@google.com' }, env);
  const m = (carrier = google, rawSize = 1000) => ({ domainId: 1, workspaceId: 'ws_a', day: '2026-11-14', rawSize, envelopeFrom: 'x@y.example', carrier });

  it('lets a message through until the address cap, then names the cap; a refused message uses nothing', async () => {
    const q = setup();
    const limits = { ...intakeLimits(env), addressMessagesPerDay: 2 };
    expect((await chargeIntakeCaps(q, m(), limits)).reason).toBeNull();
    expect((await chargeIntakeCaps(q, m(), limits)).reason).toBeNull();
    expect((await chargeIntakeCaps(q, m(), limits)).reason).toBe('cap_address_day');
    expect((await chargeIntakeCaps(q, m(), limits)).reason).toBe('cap_address_day'); // still 2 used, not 3 or 4
  });
  it('charges the carrier class\'s own bucket: an unauthenticated sender hits its small caps first', async () => {
    const q = setup();
    const limits = { ...intakeLimits(env), unauthReportsPerDay: 1 };
    const unauth = carrierFromHeaders(undefined, env);
    expect((await chargeIntakeCaps(q, m(unauth), limits)).reason).toBeNull();
    expect((await chargeIntakeCaps(q, m(unauth), limits)).reason).toBe('cap_unauth_day');
    expect((await chargeIntakeCaps(q, m(), limits)).reason).toBeNull(); // a registry reporter is unaffected
  });
});
