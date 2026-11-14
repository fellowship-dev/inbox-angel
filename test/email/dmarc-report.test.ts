// Integration tests for handleDmarcReport.
// Mocks all I/O: message.raw stream, D1, and the module collaborators.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../../src/index';
import { makeTenant } from '../helpers/tenant';
import type { Domain } from '../../src/db/types';
import type { AggregateReport } from '../../src/dmarc/types';

// ── Module mocks ──────────────────────────────────────────────
// Must be declared before importing the module under test.

vi.mock('../../src/email/mime-extract', () => ({
  extractAttachmentBytes: vi.fn(),
  MimeExtractError: class MimeExtractError extends Error {
    constructor(msg: string) { super(msg); this.name = 'MimeExtractError'; }
  },
}));

vi.mock('../../src/email/resolve-domain', () => ({
  resolveDomain: vi.fn(),
}));

vi.mock('../../src/dmarc/parse-email', () => ({
  parseDmarcEmail: vi.fn(),
  ParseEmailError: class ParseEmailError extends Error {
    constructor(msg: string) { super(msg); this.name = 'ParseEmailError'; }
  },
}));

vi.mock('../../src/dmarc/store-report', () => ({
  storeReport: vi.fn(),
}));

import { handleDmarcReport, StorageFailure } from '../../src/email/dmarc-report';
import { carrierFromHeaders } from '../../src/dmarc/reporter-auth';
import * as mimeExtract from '../../src/email/mime-extract';
import * as resolveDomainMod from '../../src/email/resolve-domain';
import * as parseEmailMod from '../../src/dmarc/parse-email';
import * as storeReportMod from '../../src/dmarc/store-report';

// ── Fixtures ──────────────────────────────────────────────────

const DOMAIN: Domain = {
  id: 1,
  domain: 'acme.com',
  rua_address: 'rua@reports.readysetmail.com',
  dmarc_policy: 'reject',
  dmarc_pct: 100,
  spf_record: null,
  auth_record_provisioned: 1,
  dns_record_id: null,
  spf_lookup_count: null,
  created_at: 1700000000,
  updated_at: 1700000000,
};

const REPORT: AggregateReport = {
  xml_schema: 'draft',
  report_metadata: {
    org_name: 'google.com',
    org_email: 'noreply@google.com',
    org_extra_contact_info: null,
    report_id: 'report-abc-001',
    begin_date: '2024-06-13T00:00:00Z',
    end_date: '2024-06-13T23:59:59Z',
    errors: [],
  },
  policy_published: {
    domain: 'acme.com', adkim: 'r', aspf: 'r', p: 'reject', sp: 'reject', pct: 100, fo: '0',
  },
  records: [],
};

function makeStream(content = 'fake-gz-bytes'): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(content);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

function makeMessage(overrides: Partial<{
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
}> = {}): ForwardableEmailMessage {
  return {
    from: overrides.from ?? 'dmarc-reports@google.com',
    to: overrides.to ?? 'rua@reports.readysetmail.com',
    headers: new Headers(),
    raw: overrides.raw ?? makeStream(),
    rawSize: 100,
    reply: vi.fn(),
    forward: vi.fn(),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

function makeEnv() {
  const tenant = makeTenant({ db: {} });
  // the gate asks D1 whether the report is already stored (per domain, reporter identity, report id), and a storage failure is counted for the owner: stub both
  tenant.scope.reports.isDuplicate = vi.fn().mockResolvedValue(false);
  tenant.scope.intake.markFailure = vi.fn().mockResolvedValue(1);
  return tenant;
}

// ── Test setup ────────────────────────────────────────────────

beforeEach(() => {
  // Happy-path defaults — individual tests override as needed
  vi.mocked(mimeExtract.extractAttachmentBytes).mockResolvedValue(new Uint8Array([0x1f, 0x8b]));
  vi.mocked(resolveDomainMod.resolveDomain).mockResolvedValue(DOMAIN);
  // the real parser calls the gate once the report's header is known; the mock does the same
  vi.mocked(parseEmailMod.parseDmarcEmail).mockImplementation(async (_bytes, _offline, _db, opts) => {
    await (opts as { gate?: (i: unknown) => Promise<void> }).gate?.({ report_id: REPORT.report_metadata.report_id, policy_domain: REPORT.policy_published.domain, report_email: REPORT.report_metadata.org_email, record_count: REPORT.records.length });
    return REPORT;
  });
  vi.mocked(storeReportMod.storeReport).mockResolvedValue({ stored: true, reportId: 42 });
});

afterEach(() => vi.clearAllMocks());

// ── Happy path ────────────────────────────────────────────────

describe('handleDmarcReport — happy path', () => {
  it('reads the attachment from (a branch of) message.raw', async () => {
    const raw = makeStream();
    const message = makeMessage({ raw });
    await handleDmarcReport(message, makeEnv());

    expect(mimeExtract.extractAttachmentBytes).toHaveBeenCalledOnce();
    expect((mimeExtract.extractAttachmentBytes as any).mock.calls[0][0]).toBeInstanceOf(ReadableStream);
  });

  it('calls resolveDomain with the tenant and the policy_domain from the report', async () => {
    const env = makeEnv();
    await handleDmarcReport(makeMessage(), env);

    expect(resolveDomainMod.resolveDomain).toHaveBeenCalledWith(env, 'acme.com');
  });

  it('calls parseDmarcEmail with the extracted bytes', async () => {
    const fakeBytes = new Uint8Array([1, 2, 3]);
    vi.mocked(mimeExtract.extractAttachmentBytes).mockResolvedValue(fakeBytes);

    await handleDmarcReport(makeMessage(), makeEnv());

    // parseDmarcEmail now takes (bytes, offline, db)
    expect(parseEmailMod.parseDmarcEmail).toHaveBeenCalledWith(fakeBytes, false, expect.anything(), expect.objectContaining({ maxBytes: 1.25 * 1024 * 1024, maxRecords: 2_500, maxNewIps: 200, gate: expect.any(Function) })); // self-host counting every report: no tier restriction (the registry cap)
  });

  it('calls storeReport with correct domain id', async () => {
    const env = makeEnv();
    await handleDmarcReport(makeMessage(), env);

    const [calledTenant, calledDomainId, calledReport] =
      vi.mocked(storeReportMod.storeReport).mock.calls[0];
    expect(calledTenant).toBe(env);
    expect(calledDomainId).toBe(1);
    expect(calledReport).toBe(REPORT);
  });

  it('does not call setReject on success', async () => {
    const message = makeMessage();
    await handleDmarcReport(message, makeEnv());

    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('stores rawXml=null for binary (gz) attachments', async () => {
    vi.mocked(mimeExtract.extractAttachmentBytes).mockResolvedValue(
      new Uint8Array([0x1f, 0x8b, 0x08])
    );
    const env = makeEnv();
    await handleDmarcReport(makeMessage(), env);

    const [, , , rawXml] = vi.mocked(storeReportMod.storeReport).mock.calls[0];
    expect(rawXml).toBeNull();
  });

  it('stores rawXml string for plain XML attachments', async () => {
    const xml = '<?xml version="1.0"?><feedback></feedback>';
    vi.mocked(mimeExtract.extractAttachmentBytes).mockResolvedValue(
      new TextEncoder().encode(xml)
    );
    const env = makeEnv();
    await handleDmarcReport(makeMessage(), env);

    const [, , , rawXml] = vi.mocked(storeReportMod.storeReport).mock.calls[0];
    expect(rawXml).toBe(xml);
  });

  it('does not throw when storeReport returns stored=false (duplicate)', async () => {
    vi.mocked(storeReportMod.storeReport).mockResolvedValue({ stored: false });
    const message = makeMessage();
    const result = await handleDmarcReport(message, makeEnv());
    expect(result).toHaveProperty('failure_count');
    expect(message.setReject).not.toHaveBeenCalled();
  });
});

// ── Error paths ───────────────────────────────────────────────

describe('handleDmarcReport — error paths', () => {
  it('calls setReject when MIME extraction fails', async () => {
    vi.mocked(mimeExtract.extractAttachmentBytes).mockRejectedValue(
      new mimeExtract.MimeExtractError('No DMARC attachment found')
    );
    const message = makeMessage();
    await handleDmarcReport(message, makeEnv());

    expect(message.setReject).toHaveBeenCalledOnce();
    expect((message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'Could not extract attachment'
    );
  });

  it('calls setReject for unexpected MIME extraction error', async () => {
    vi.mocked(mimeExtract.extractAttachmentBytes).mockRejectedValue(new Error('network timeout'));
    const message = makeMessage();
    await handleDmarcReport(message, makeEnv());

    expect(message.setReject).toHaveBeenCalledOnce();
    expect((message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'Unexpected error'
    );
  });

  it('calls setReject when policy_domain is not registered', async () => {
    vi.mocked(resolveDomainMod.resolveDomain).mockResolvedValue(null);
    const message = makeMessage();
    await handleDmarcReport(message, makeEnv());

    expect(message.setReject).toHaveBeenCalledOnce();
    expect((message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'Unknown domain'
    );
  });

  it('calls parseDmarcEmail but not storeReport when policy_domain is unknown', async () => {
    vi.mocked(resolveDomainMod.resolveDomain).mockResolvedValue(null);
    await handleDmarcReport(makeMessage(), makeEnv());

    expect(parseEmailMod.parseDmarcEmail).toHaveBeenCalled();
    expect(storeReportMod.storeReport).not.toHaveBeenCalled();
  });

  it('calls setReject when parseDmarcEmail throws ParseEmailError', async () => {
    vi.mocked(parseEmailMod.parseDmarcEmail).mockRejectedValue(
      new parseEmailMod.ParseEmailError('Invalid DMARC report XML')
    );
    const message = makeMessage();
    await handleDmarcReport(message, makeEnv());

    expect(message.setReject).toHaveBeenCalledOnce();
    expect((message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'Invalid DMARC report'
    );
  });

  it('calls setReject for unexpected parse error', async () => {
    vi.mocked(parseEmailMod.parseDmarcEmail).mockRejectedValue(new Error('out of memory'));
    const message = makeMessage();
    await handleDmarcReport(message, makeEnv());

    expect(message.setReject).toHaveBeenCalledOnce();
    expect((message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(
      'Unexpected error'
    );
  });

  it('a storage failure is never accepted-and-dropped: it throws (the sender retries) and is counted for the owner', async () => {
    vi.mocked(storeReportMod.storeReport).mockRejectedValue(new Error('D1 unavailable'));
    const message = makeMessage();
    const tenant = makeEnv();
    await expect(handleDmarcReport(message, tenant)).rejects.toBeInstanceOf(StorageFailure);
    expect(message.setReject).not.toHaveBeenCalled();
    expect(tenant.scope.intake.markFailure).toHaveBeenCalledWith(1, expect.stringMatching(/^\d{4}-\d\d-\d\d$/), 'storage_failed', expect.any(Number));
  });

  it('an uncounted sender\'s message that has failed too often today is refused for good (the counter is per message, not per domain)', async () => {
    vi.mocked(storeReportMod.storeReport).mockRejectedValue(new Error('D1 unavailable'));
    const tenant = makeTenant({ db: {}, mode: 'saas', env: { MODE: 'saas' } as any });
    tenant.scope.reports.isDuplicate = vi.fn().mockResolvedValue(false);
    tenant.scope.intake.markFailure = vi.fn().mockResolvedValue(500); // a domain-wide count is NOT what decides
    tenant.scope.intake.noteStorageFailure = vi.fn().mockResolvedValue(21);
    const message = makeMessage();
    const result = await handleDmarcReport(message, tenant);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'storage_failed_repeatedly' });
    expect(message.setReject).toHaveBeenCalledWith('Report could not be stored after repeated attempts');
    expect(tenant.scope.intake.noteStorageFailure).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{24}$/), expect.stringMatching(/^\d{4}-\d\d-\d\d$/));
  });

  it('a domain with many failures of OTHER messages does not refuse this one', async () => {
    vi.mocked(storeReportMod.storeReport).mockRejectedValue(new Error('D1 unavailable'));
    const tenant = makeTenant({ db: {}, mode: 'saas', env: { MODE: 'saas' } as any });
    tenant.scope.reports.isDuplicate = vi.fn().mockResolvedValue(false);
    tenant.scope.intake.markFailure = vi.fn().mockResolvedValue(500);
    tenant.scope.intake.noteStorageFailure = vi.fn().mockResolvedValue(1);
    const message = makeMessage();
    await expect(handleDmarcReport(message, tenant)).rejects.toBeInstanceOf(StorageFailure);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('a report already stored is a duplicate: accepted, not stored again, nothing enriched', async () => {
    const tenant = makeEnv();
    tenant.scope.reports.isDuplicate = vi.fn().mockResolvedValue(true);
    const message = makeMessage();
    const result = await handleDmarcReport(message, tenant);
    expect(result).toMatchObject({ outcome: 'duplicate', reason: 'duplicate' });
    expect(storeReportMod.storeReport).not.toHaveBeenCalled();
    expect(message.setReject).not.toHaveBeenCalled();
  });
});

// ── Three-tier flow ───────────────────────────────────────────

describe('handleDmarcReport — tiers', () => {
  const googleCarrier = () => carrierFromHeaders(
    { ar: 'mx.test; dkim=pass header.d=google.com; spf=pass', from: 'noreply-dmarc-support@google.com' } as never,
    { AUTHSERV_ID: 'mx.test', AUTHSERV_HEADER: 'ar' },
  );

  it('an unauthenticated carrier is stored but not counted, keyed on the ~unauth identity', async () => {
    const tenant = makeEnv();
    const result = await handleDmarcReport(makeMessage(), tenant);
    expect(result).toMatchObject({ outcome: 'accepted', tier: 'unauthenticated', identity: '~unauth' });
    expect(tenant.scope.reports.isDuplicate).toHaveBeenCalledWith(1, '~unauth', 'report-abc-001', false);
    expect(vi.mocked(storeReportMod.storeReport).mock.calls[0][5]).toMatchObject({ tier: 'unauthenticated', identity: '~unauth', domain: null });
  });

  it('an authenticated registry carrier whose report email is accepted is counted', async () => {
    const carrier = googleCarrier();
    expect(carrier.class).toBe('registry');
    const tenant = makeEnv();
    const result = await handleDmarcReport(makeMessage(), tenant, { carrier });
    // the mock gate reports noreply@google.com, which Google's entry does not accept: not counted
    expect(result).toMatchObject({ outcome: 'accepted', tier: 'unknown', identity: 'google', emailMatched: false });

    vi.mocked(parseEmailMod.parseDmarcEmail).mockImplementation(async (_b, _o, _d, opts) => {
      await (opts as { gate?: (i: unknown) => Promise<unknown> }).gate?.({ report_id: 'r2', policy_domain: 'acme.com', report_email: 'noreply-dmarc-support@google.com', record_count: 0 });
      return REPORT;
    });
    const counted = await handleDmarcReport(makeMessage(), tenant, { carrier });
    expect(counted).toMatchObject({ outcome: 'accepted', tier: 'counted', identity: 'google', emailMatched: true });
    expect(tenant.scope.reports.isDuplicate).toHaveBeenLastCalledWith(1, 'google', 'r2', true);
    expect(vi.mocked(storeReportMod.storeReport).mock.calls.at(-1)![5]).toMatchObject({ tier: 'counted', identity: 'google', knownAs: 'Google', auth: 'pass' });
  });
});
