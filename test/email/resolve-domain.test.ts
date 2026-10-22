import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { resolveDomain } from '../../src/email/resolve-domain';
import type { Domain } from '../../src/db/types';

// ── Fixtures ──────────────────────────────────────────────────

const DOMAIN: Domain = {
  id: 1,
  domain: 'acme.com',
  rua_address: 'rua@reports.inboxangel.io',
  dmarc_policy: 'quarantine',
  dmarc_pct: 100,
  spf_record: 'v=spf1 -all',
  auth_record_provisioned: 1,
  dns_record_id: null,
  spf_lookup_count: null,
  created_at: 1700000000,
  updated_at: 1700000000,
};

// Build a real in-memory D1 database containing the given domain row (if any)
function makeDb(domain: Domain | null): D1Database {
  const db = createMigratedD1();
  if (domain) {
    db.sqlite
      .prepare(
        `INSERT INTO domains (id, domain, rua_address, dmarc_policy, dmarc_pct, spf_record, auth_record_provisioned, dns_record_id, spf_lookup_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        domain.id, domain.domain, domain.rua_address, domain.dmarc_policy, domain.dmarc_pct, domain.spf_record,
        domain.auth_record_provisioned, domain.dns_record_id, domain.spf_lookup_count, domain.created_at, domain.updated_at,
      );
  }
  return db as unknown as D1Database;
}

// ── Tests ─────────────────────────────────────────────────────

describe('resolveDomain', () => {
  it('returns domain for a known policy domain', async () => {
    const db = makeDb(DOMAIN);
    const result = await resolveDomain(db, 'acme.com');

    expect(result).not.toBeNull();
    expect(result!.id).toBe(1);
    expect(result!.domain).toBe('acme.com');
  });

  it('returns null when domain is not in domains table', async () => {
    const db = makeDb(null);
    const result = await resolveDomain(db, 'unknown.com');
    expect(result).toBeNull();
  });

  it('normalises the policy domain to lowercase before lookup', async () => {
    const db = makeDb(DOMAIN); // stored lowercase
    const result = await resolveDomain(db, 'ACME.COM');

    expect(result).not.toBeNull();
    expect(result!.domain).toBe('acme.com');
  });

  it('preserves all domain fields in the result', async () => {
    const db = makeDb(DOMAIN);
    const result = await resolveDomain(db, 'acme.com');
    // The real row carries additional columns (rollout, parent, etc.); every fixture field must match.
    expect(result).toMatchObject(DOMAIN);
  });

  it('returns different domains for different lookups', async () => {
    const domain2: Domain = { ...DOMAIN, id: 2, domain: 'acme.io', rua_address: 'rua@reports.inboxangel.io' };
    const db = makeDb(domain2);
    const result = await resolveDomain(db, 'acme.io');

    expect(result!.domain).toBe('acme.io');
    expect(result!.id).toBe(2);
  });
});
