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

import { handleDmarcReport } from '../../src/email/dmarc-report';
import * as mimeExtract from '../../src/email/mime-extract';
import * as resolveDomainMod from '../../src/email/resolve-domain';
import * as parseEmailMod from '../../src/dmarc/parse-email';
import * as storeReportMod from '../../src/dmarc/store-report';

// ── Fixtures ──────────────────────────────────────────────────

const DOMAIN: Domain = {
  id: 1,
  domain: 'acme.com',
  rua_address: 'rua@reports.inboxangel.io',
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
    to: overrides.to ?? 'rua@reports.inboxangel.com',
    headers: new Headers(),
    raw: overrides.raw ?? makeStream(),
    rawSize: 100,
    reply: vi.fn(),
    forward: vi.fn(),
    setReject: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

function makeEnv() {
  return makeTenant({ db: {} });
}

// ── Test setup ────────────────────────────────────────────────

beforeEach(() => {
  // Happy-path defaults — individual tests override as needed
  vi.mocked(mimeExtract.extractAttachmentBytes).mockResolvedValue(new Uint8Array([0x1f, 0x8b]));
  vi.mocked(resolveDomainMod.resolveDomain).mockResolvedValue(DOMAIN);
  vi.mocked(parseEmailMod.parseDmarcEmail).mockResolvedValue(REPORT);
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
    expect(parseEmailMod.parseDmarcEmail).toHaveBeenCalledWith(fakeBytes, false, expect.anything(), { maxBytes: 25 * 1024 * 1024 });
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

  it('does not call setReject when storeReport throws (storage failure is non-fatal)', async () => {
    vi.mocked(storeReportMod.storeReport).mockRejectedValue(new Error('D1 unavailable'));
    const message = makeMessage();
    await handleDmarcReport(message, makeEnv());

    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('resolves without throwing when storeReport fails', async () => {
    vi.mocked(storeReportMod.storeReport).mockRejectedValue(new Error('D1 unavailable'));
    const result = await handleDmarcReport(makeMessage(), makeEnv());
    expect(result).toHaveProperty('failure_count');
  });
});
