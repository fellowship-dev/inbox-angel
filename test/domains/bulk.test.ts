import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    reportsDomain: vi.fn().mockReturnValue('reports.inboxangel.io'),
  };
});

vi.mock('../../src/dns/provision', () => ({
  provisionDomain: vi.fn().mockResolvedValue({ recordId: 'dns-rec-1', recordName: 'test.com._report._dmarc.reports.inboxangel.io', manual: false }),
}));

vi.mock('../../src/audit/log', () => ({
  logAudit: vi.fn(),
}));

import { createMigratedD1 } from '@inbox-angel/db/testing';
import { parseDomainList, validateDomain, bulkInsertDomains } from '../../src/domains/bulk';

// ── parseDomainList ───────────────────────────────────────────

describe('parseDomainList', () => {
  it('splits by newlines', () => {
    expect(parseDomainList('acme.com\nexample.com')).toEqual(['acme.com', 'example.com']);
  });

  it('splits by commas', () => {
    expect(parseDomainList('acme.com,example.com')).toEqual(['acme.com', 'example.com']);
  });

  it('splits by mixed delimiters', () => {
    expect(parseDomainList('acme.com, example.com\nfoo.io')).toEqual(['acme.com', 'example.com', 'foo.io']);
  });

  it('lowercases entries', () => {
    expect(parseDomainList('ACME.COM\nFOO.IO')).toEqual(['acme.com', 'foo.io']);
  });

  it('deduplicates entries', () => {
    expect(parseDomainList('acme.com\nacme.com\nacme.com')).toEqual(['acme.com']);
  });

  it('trims whitespace', () => {
    expect(parseDomainList('  acme.com  \n  foo.io  ')).toEqual(['acme.com', 'foo.io']);
  });

  it('ignores empty lines', () => {
    expect(parseDomainList('\n\nacme.com\n\n')).toEqual(['acme.com']);
  });
});

// ── validateDomain ───────────────────────────────────────────

describe('validateDomain', () => {
  it('accepts a valid domain', () => {
    expect(validateDomain('example.com')).toBe(true);
  });

  it('accepts a subdomain', () => {
    expect(validateDomain('mail.example.com')).toBe(true);
  });

  it('accepts a domain with hyphens', () => {
    expect(validateDomain('my-domain.co.uk')).toBe(true);
  });

  it('rejects a domain with spaces', () => {
    expect(validateDomain('my domain.com')).toBe(false);
  });

  it('rejects a bare label with no TLD', () => {
    expect(validateDomain('localhost')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(validateDomain('')).toBe(false);
  });

  it('rejects a single-char TLD', () => {
    expect(validateDomain('example.c')).toBe(false);
  });
});

// ── bulkInsertDomains ─────────────────────────────────────────

function makeDb() {
  const db = createMigratedD1();
  const domainRows = () => db.sqlite.prepare('SELECT * FROM domains ORDER BY id').all() as Record<string, any>[];
  return Object.assign(db as unknown as D1Database, { domainRows });
}

function seedDomain(db: D1Database, domain: string) {
  (db as any).sqlite
    .prepare("INSERT INTO domains (domain, rua_address) VALUES (?, 'rua@reports.inboxangel.io')")
    .run(domain);
}

describe('bulkInsertDomains', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns imported status for a new valid domain', async () => {
    const db = makeDb(); // empty = not duplicate
    const results = await bulkInsertDomains({ DB: db, CLOUDFLARE_API_TOKEN: 'tok' }, ['acme.com']);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('imported');
    expect(results[0].domain).toBe('acme.com');
    const rows = db.domainRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: 'acme.com', rua_address: 'rua@reports.inboxangel.io', dns_record_id: 'dns-rec-1' });
  });

  it('returns duplicate status when domain already exists', async () => {
    const db = makeDb();
    seedDomain(db, 'acme.com'); // existing row
    const results = await bulkInsertDomains({ DB: db }, ['acme.com']);
    expect(results[0].status).toBe('duplicate');
    expect(db.domainRows()).toHaveLength(1);
  });

  it('returns invalid status for a malformed domain', async () => {
    const db = makeDb();
    const results = await bulkInsertDomains({ DB: db }, ['not a domain']);
    expect(results[0].status).toBe('invalid');
    expect(db.domainRows()).toHaveLength(0);
  });

  it('processes a mixed list and returns per-row status', async () => {
    const db = makeDb();
    seedDomain(db, 'dupe.com');

    const results = await bulkInsertDomains({ DB: db, CLOUDFLARE_API_TOKEN: 'tok' }, ['acme.com', 'not-valid!', 'dupe.com']);
    expect(results.find(r => r.domain === 'acme.com')?.status).toBe('imported');
    expect(results.find(r => r.domain === 'not-valid!')?.status).toBe('invalid');
    expect(results.find(r => r.domain === 'dupe.com')?.status).toBe('duplicate');
    expect(db.domainRows().map(r => r.domain).sort()).toEqual(['acme.com', 'dupe.com']);
  });

  it('caps batch at 50 entries', async () => {
    const db = makeDb();
    const domains = Array.from({ length: 60 }, (_, i) => `domain${i}.com`);
    const results = await bulkInsertDomains({ DB: db }, domains);
    expect(results).toHaveLength(50);
    expect(db.domainRows()).toHaveLength(50);
  });

  it('returns imported with manual_dns=true when provisioning falls back to manual mode', async () => {
    const { provisionDomain } = await import('../../src/dns/provision');
    vi.mocked(provisionDomain).mockResolvedValueOnce({ recordId: null, recordName: 'acme.com._report._dmarc.reports.inboxangel.io', manual: true });
    const db = makeDb();
    const results = await bulkInsertDomains({ DB: db }, ['acme.com']);
    expect(results[0].status).toBe('imported');
    expect(results[0].manual_dns).toBe(true);
    expect(db.domainRows()[0].dns_record_id).toBeNull();
  });
});
