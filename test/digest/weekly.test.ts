import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDigestBody, sendWeeklyDigests } from '../../src/digest/weekly';
import type { DomainWeeklyStat, FailingSource } from '@inbox-angel/db';
import { createMigratedD1 } from '@inbox-angel/db/testing';

// ── Fixtures ──────────────────────────────────────────────────

const ADMIN = { email: 'admin@acme.com', name: 'Acme' };

const STAT_GOOD: DomainWeeklyStat = {
  domain_id: 1, domain: 'acme.com', dmarc_policy: 'reject',
  total_messages: 1000, pass_messages: 980, fail_messages: 20, report_count: 5,
};

const STAT_CLEAN: DomainWeeklyStat = {
  domain_id: 2, domain: 'acme.io', dmarc_policy: 'reject',
  total_messages: 200, pass_messages: 200, fail_messages: 0, report_count: 2,
};

const STAT_NONE: DomainWeeklyStat = {
  domain_id: 3, domain: 'acme.net', dmarc_policy: 'none',
  total_messages: 50, pass_messages: 30, fail_messages: 20, report_count: 1,
};

const STAT_NO_REPORTS: DomainWeeklyStat = {
  domain_id: 4, domain: 'acme.org', dmarc_policy: null,
  total_messages: 0, pass_messages: 0, fail_messages: 0, report_count: 0,
};

const SOURCE: FailingSource = { source_ip: '1.2.3.4', total: 20, header_from: 'mail.acme.com' };

// ── buildDigestBody ───────────────────────────────────────────

describe('buildDigestBody', () => {
  it('includes recipient name in greeting', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('Hi Acme');
  });

  it('includes domain name and policy', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('Domain: acme.com');
    expect(body).toContain('reject ✅');
  });

  it('shows message counts and pass percentage', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('1,000');
    expect(body).toContain('98%');
  });

  it('shows top failing sources when present', () => {
    const sources = new Map([[1, [SOURCE]]]);
    const body = buildDigestBody('Acme', [STAT_GOOD], sources, 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('1.2.3.4');
    expect(body).toContain('mail.acme.com');
  });

  it('shows rua hint for domains with no reports', () => {
    const body = buildDigestBody('Acme', [STAT_NO_REPORTS], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('No reports received');
    expect(body).toContain('rua=mailto:rua@reports.inboxangel.io');
  });

  it('includes CTA for domains with weak policy', () => {
    const body = buildDigestBody('Acme', [STAT_NONE], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('not enforcing DMARC');
    expect(body).toContain('inboxangel.io');
  });

  it('no CTA when all domains have reject policy', () => {
    const body = buildDigestBody('Acme', [STAT_CLEAN], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).not.toContain('not enforcing DMARC');
  });

  it('handles multiple domains', () => {
    const body = buildDigestBody('Acme', [STAT_GOOD, STAT_CLEAN], new Map(), 'Mar 3, 2026', 'rua@reports.inboxangel.io', 'reports.inboxangel.io');
    expect(body).toContain('acme.com');
    expect(body).toContain('acme.io');
  });
});

// ── sendWeeklyDigests ─────────────────────────────────────────

type TestDb = ReturnType<typeof createMigratedD1>;

const NOW_MS = Date.UTC(2026, 2, 10, 9, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

function seedAdmin(db: TestDb, admin: { email: string; name: string } | null = ADMIN) {
  if (!admin) return;
  db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', ?, ?, 'admin')").run(admin.email, admin.name);
  db.sqlite.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES ('acct_default', 'u1', 'owner')").run();
}

/** Insert a domain with one aggregate report in the last 7 days matching `stat`, plus failing-source records. */
function seedDomain(db: TestDb, stat: DomainWeeklyStat, failingSources: FailingSource[] = []) {
  db.sqlite
    .prepare("INSERT INTO domains (id, domain, rua_address, dmarc_policy) VALUES (?, ?, 'rua@reports.inboxangel.io', ?)")
    .run(stat.domain_id, stat.domain, stat.dmarc_policy);
  if (stat.report_count === 0) return;
  // report_count reports; the first carries all the counts
  for (let i = 0; i < stat.report_count; i++) {
    const first = i === 0;
    const res = db.sqlite
      .prepare(
        `INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count)
         VALUES (?, 'google.com', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stat.domain_id, `r-${stat.domain_id}-${i}`, NOW_S - 86400, NOW_S,
        first ? stat.total_messages : 0, first ? stat.pass_messages : 0, first ? stat.fail_messages : 0,
      );
    if (first) {
      for (const s of failingSources) {
        db.sqlite
          .prepare(
            `INSERT INTO report_records (report_id, source_ip, count, disposition, dkim_result, spf_result, header_from)
             VALUES (?, ?, ?, 'none', 'fail', 'fail', ?)`,
          )
          .run(res.lastInsertRowid, s.source_ip, s.total, s.header_from);
      }
    }
  }
}

function makeEnv(db: TestDb, extra: Record<string, unknown> = {}) {
  return {
    DB: db as unknown as D1Database,
    FROM_EMAIL: 'noreply@reports.inboxangel.io',
    REPORTS_DOMAIN: 'reports.inboxangel.io',
    ...extra,
  };
}

function sentText(sendEmail: { send: ReturnType<typeof vi.fn> }): string {
  return sendEmail.send.mock.calls[0][0].text as string;
}

describe('sendWeeklyDigests', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createMigratedD1();
    seedAdmin(db);
    seedDomain(db, STAT_GOOD, [SOURCE]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls getWeeklyDomainStats', async () => {
    // Weekly stats are read from the DB and rendered into the digest.
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests(makeEnv(db, { SEND_EMAIL: sendEmail }) as any, NOW_MS);
    const text = sentText(sendEmail);
    expect(text).toContain('Domain: acme.com');
    expect(text).toContain('1,000');
    expect(text).toContain('98%');
    consoleSpy.mockRestore();
  });

  it('only counts reports within the last 7 days', async () => {
    db.sqlite.prepare("UPDATE aggregate_reports SET date_begin = ? WHERE domain_id = 1").run(NOW_S - 8 * 86400);
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests(makeEnv(db, { SEND_EMAIL: sendEmail }) as any, NOW_MS);
    expect(sentText(sendEmail)).toContain('No reports received this week.');
    consoleSpy.mockRestore();
  });

  it('fetches failing sources only for domains with failures', async () => {
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests(makeEnv(db, { SEND_EMAIL: sendEmail }) as any, NOW_MS);
    const text = sentText(sendEmail);
    expect(text).toContain('Top failing sources:');
    expect(text).toContain('1.2.3.4 (mail.acme.com) — 20 failures');
    consoleSpy.mockRestore();
  });

  it('skips getTopFailingSources when domain has no failures', async () => {
    // Replace the failing domain with a clean one that nevertheless has a failing record
    // in the DB: it must not surface, because the per-source query is skipped when fail_messages = 0.
    db.sqlite.exec('DELETE FROM domains');
    seedDomain(db, STAT_CLEAN, [{ source_ip: '9.9.9.9', total: 5, header_from: 'x.acme.io' }]);
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests(makeEnv(db, { SEND_EMAIL: sendEmail }) as any, NOW_MS);
    const text = sentText(sendEmail);
    expect(text).toContain('Domain: acme.io');
    expect(text).not.toContain('Top failing sources:');
    expect(text).not.toContain('9.9.9.9');
    consoleSpy.mockRestore();
  });

  it('sends email via SEND_EMAIL binding when configured', async () => {
    const sendEmail = { send: vi.fn().mockResolvedValue(undefined) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests({ ...makeEnv(db), SEND_EMAIL: sendEmail } as any, NOW_MS);
    expect(sendEmail.send).toHaveBeenCalledOnce();
    expect(sendEmail.send.mock.calls[0][0].to).toEqual(['admin@acme.com']);
    consoleSpy.mockRestore();
  });

  it('logs instead of sending when SEND_EMAIL binding is absent', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests(makeEnv(db) as any, NOW_MS); // no SEND_EMAIL
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('would send to admin@acme.com'));
    consoleSpy.mockRestore();
  });

  it('skips when no domains exist', async () => {
    db.sqlite.exec('DELETE FROM domains');
    const sendEmail = { send: vi.fn() };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests({ ...makeEnv(db), SEND_EMAIL: sendEmail } as any, NOW_MS);
    expect(sendEmail.send).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('skips when no admin user exists', async () => {
    db.sqlite.exec('DELETE FROM users');
    const sendEmail = { send: vi.fn() };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendWeeklyDigests({ ...makeEnv(db), SEND_EMAIL: sendEmail } as any, NOW_MS);
    expect(sendEmail.send).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('no admin user found'));
    consoleSpy.mockRestore();
  });
});
