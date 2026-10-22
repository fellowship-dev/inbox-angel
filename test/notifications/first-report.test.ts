import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { buildFirstReportBody, sendFirstReportNotification, ReportStats } from '../../src/notifications/first-report';

// ── Module mocks (only affects storeReport's import) ─────────

vi.mock('../../src/env-utils', () => ({
  reportsDomain: vi.fn(() => 'reports.acme.com'),
  fromEmail: vi.fn(() => 'noreply@reports.acme.com'),
  getAccountId: vi.fn(() => 'test-account-id'),
  getWorkersSubdomain: vi.fn(() => 'testaccount'),
}));

// ── Fixtures ──────────────────────────────────────────────────

const ADMIN = { email: 'admin@acme.com', name: 'Acme Admin' };

const STATS: ReportStats = {
  totalMessages: 150,
  passMessages: 140,
  failMessages: 10,
  sourceCount: 5,
};

function makeEnv(overrides: { admin?: typeof ADMIN | null; sendEmail?: boolean; customDomain?: string | null } = {}) {
  const admin = overrides.admin === undefined ? ADMIN : overrides.admin;
  const customDomain = overrides.customDomain !== undefined ? overrides.customDomain : 'inbox.acme.com';
  const db = createMigratedD1();
  if (admin) {
    // users.name is NOT NULL in the real schema; a null name is simulated by the caller via nullAdminName().
    db.sqlite
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', ?, ?, 'admin')")
      .run(admin.email, admin.name ?? '');
    db.sqlite.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES ('acct_default', 'u1', 'owner')").run();
  }
  if (customDomain) {
    db.sqlite
      .prepare("INSERT INTO settings (account_id, key, value) VALUES ('acct_default', 'custom_domain', ?)")
      .run(customDomain);
  }
  // workers_subdomain is not cached in settings — triggers the env-utils fallback
  return {
    DB: db as unknown as D1Database,
    ...(overrides.sendEmail !== false
      ? { SEND_EMAIL: { send: vi.fn().mockResolvedValue(undefined) } as any }
      : {}),
  };
}

/** The real schema forbids a NULL users.name; make the admin lookup return one anyway. */
function nullAdminName(env: { DB: D1Database }) {
  const db = env.DB as any;
  const realPrepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const stmt = realPrepare(sql);
    if (/from "users"/i.test(sql)) {
      // Drizzle reads rows with .raw(): [id, email, name]
      return { ...stmt, bind: () => ({ raw: async () => [['u1', 'admin@acme.com', null]] }) };
    }
    return stmt;
  });
}

// ── buildFirstReportBody ──────────────────────────────────────

describe('buildFirstReportBody', () => {
  it('includes recipient name in greeting', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('Hi Acme Admin');
  });

  it('includes the domain name', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('acme.com');
    expect(body).toContain('first DMARC aggregate report');
  });

  it('includes stats in body', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('150 email(s) analyzed');
    expect(body).toContain('5 sending source(s) detected');
    expect(body).toContain('93% pass rate');
    expect(body).toContain('140 passed');
    expect(body).toContain('10 failed');
  });

  it('includes dashboard link', () => {
    const body = buildFirstReportBody('Acme Admin', 'acme.com', STATS, 'https://acme.com');
    expect(body).toContain('https://acme.com');
  });

  it('handles zero messages gracefully (0% pass rate)', () => {
    const zeroStats: ReportStats = { totalMessages: 0, passMessages: 0, failMessages: 0, sourceCount: 0 };
    const body = buildFirstReportBody('Admin', 'acme.com', zeroStats, 'https://acme.com');
    expect(body).toContain('0% pass rate');
  });
});

// ── sendFirstReportNotification ───────────────────────────────

describe('sendFirstReportNotification', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends email via SEND_EMAIL binding when configured', async () => {
    const env = makeEnv();
    await sendFirstReportNotification(env, 'acme.com', STATS);

    expect(env.SEND_EMAIL!.send).toHaveBeenCalledOnce();
    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.subject).toContain('First DMARC report received for acme.com');
    expect(call.to).toEqual(['admin@acme.com']);
    expect(call.text).toContain('150 email(s) analyzed');
    expect(call.text).toContain('https://inbox.acme.com');
  });

  it('uses custom_domain for dashboard URL', async () => {
    const env = makeEnv({ customDomain: 'mail.example.org' });
    await sendFirstReportNotification(env, 'example.org', STATS);

    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.text).toContain('https://mail.example.org');
  });

  it('falls back to workers.dev with subdomain when no custom_domain', async () => {
    const env = makeEnv({ customDomain: null });
    await sendFirstReportNotification(env, 'acme.com', STATS);

    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.text).toContain('https://inbox-angel-worker.testaccount.workers.dev');
  });

  it('logs instead of sending when SEND_EMAIL binding is absent', async () => {
    const env = makeEnv({ sendEmail: false });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendFirstReportNotification(env, 'acme.com', STATS);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('would send to admin@acme.com'),
    );
    consoleSpy.mockRestore();
  });

  it('does not throw when SEND_EMAIL binding is absent', async () => {
    const env = makeEnv({ sendEmail: false });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(sendFirstReportNotification(env, 'acme.com', STATS)).resolves.not.toThrow();

    vi.restoreAllMocks();
  });

  it('skips when no admin user exists', async () => {
    const env = makeEnv({ admin: null });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendFirstReportNotification(env, 'acme.com', STATS);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('no admin user found'),
    );
    consoleSpy.mockRestore();
  });

  it('uses fallback name "there" when admin has no name', async () => {
    const env = makeEnv();
    nullAdminName(env);
    await sendFirstReportNotification(env, 'acme.com', STATS);

    const call = (env.SEND_EMAIL!.send as any).mock.calls[0][0];
    expect(call.text).toContain('Hi there');
  });
});

// ── First-report trigger in storeReport ───────────────────────

describe('storeReport first-report trigger', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeReport() {
    return {
      xml_schema: 'draft' as const,
      report_metadata: {
        org_name: 'google.com',
        org_email: 'noreply@google.com',
        org_extra_contact_info: null,
        report_id: 'report-001',
        begin_date: '2024-06-13T00:00:00Z',
        end_date: '2024-06-13T23:59:59Z',
        errors: [],
      },
      policy_published: {
        domain: 'acme.com',
        adkim: 'r' as const,
        aspf: 'r' as const,
        p: 'reject' as const,
        sp: 'reject' as const,
        pct: 100,
        fo: '0',
      },
      records: [{
        source: { ip: '1.2.3.4', reverse_dns: null, base_domain: null, country_code: null, country_name: null, subdivision: null, city: null },
        count: 10,
        alignment: { spf: true, dkim: true, dmarc: true },
        policy_evaluated: { disposition: 'none' as const, dkim: 'pass' as const, spf: 'pass' as const, policy_override_reasons: [] },
        identifiers: { header_from: 'acme.com', envelope_from: null, envelope_to: null },
        auth_results: {
          dkim: [{ domain: 'acme.com', selector: 'sel', result: 'pass' as const }],
          spf: [{ domain: 'acme.com', scope: 'mfrom', result: 'pass' as const }],
        },
      }],
    };
  }

  /** Real DB with acme.com (id 1), an admin, and `existingReports` earlier reports for the domain. */
  function makeMockDb(opts: { existingReports?: number; duplicate?: boolean } = {}) {
    const { existingReports = 0, duplicate = false } = opts;
    const db = createMigratedD1();
    db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'acme.com', 'rua@reports.acme.com')").run();
    db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'admin@acme.com', 'Admin', 'admin')").run();
    db.sqlite.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES ('acct_default', 'u1', 'owner')").run();
    for (let i = 0; i < existingReports; i++) {
      db.sqlite
        .prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end) VALUES (1, 'x', ?, 0, 1)")
        .run(i === 0 && duplicate ? 'report-001' : `old-${i}`);
    }
    return db as unknown as D1Database;
  }

  it('fires notification on first report (count=1)', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb();
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await storeReport(db, 1, makeReport(), null, { DB: db, SEND_EMAIL: sendEmail });

    // fire-and-forget — wait for microtask queue to flush
    await new Promise(r => setTimeout(r, 50));

    expect(sendEmail.send).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it('does NOT fire notification on subsequent reports (count>1)', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb({ existingReports: 4 });
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await storeReport(db, 1, makeReport(), null, { DB: db, SEND_EMAIL: sendEmail });

    await new Promise(r => setTimeout(r, 10));

    expect(sendEmail.send).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does NOT fire notification on duplicate reports (stored=false)', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb({ existingReports: 1, duplicate: true }); // report-001 already stored = duplicate
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };

    await storeReport(db, 1, makeReport(), null, { DB: db, SEND_EMAIL: sendEmail });

    await new Promise(r => setTimeout(r, 10));

    expect(sendEmail.send).not.toHaveBeenCalled();
  });

  it('does NOT fire notification when env is not provided', async () => {
    const { storeReport } = await import('../../src/dmarc/store-report');

    const db = makeMockDb();
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };

    await storeReport(db, 1, makeReport());

    await new Promise(r => setTimeout(r, 10));

    expect(sendEmail.send).not.toHaveBeenCalled();
  });
});
