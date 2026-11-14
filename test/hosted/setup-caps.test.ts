// A cap that stops real mail is counted instance-wide (no address) for the owner's setup check, then reported by instancePreflight.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

import worker from '../../src/index';
import { intakeSetupFindings } from '../../src/reports/auth-status';
import { dmarcXml, fakeMessage, gzipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from './world';

beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('caps reached, as the owner sees them', () => {
  it('a registry reporter over the address cap is dropped, counted instance-wide, and named in the setup check', async () => {
    const w = await twoWorkspaces({ INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '1' });
    for (let i = 0; i < 2; i++) {
      await worker.email(fakeMessage(`rua+${w.tokenA}@rua.readysetmail.com`, gzipReportMime(dmarcXml('a-corp.com', 'cap-' + i)), { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com' } }), w.env as any, { waitUntil: vi.fn() } as any);
    }
    expect(w.rows("SELECT scope, messages FROM intake_quota WHERE scope LIKE 'cap:%'")).toEqual([{ scope: 'cap:cap_address_day', messages: 1 }]);
    const found = await intakeSetupFindings(w.env as any);
    expect(found).toEqual([expect.objectContaining({ id: 'intake', severity: 'note', setting: 'INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY' })]);
  });
});
