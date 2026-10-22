import { IMPLICIT_ACCOUNT_ID } from '@inbox-angel/db';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import type { BoundEnv } from '../../src/index';
import { TenantContext, type TenantSettings } from '../../src/tenancy/context';
import type { Mode } from '../../src/tenancy/mode';

export interface MakeTenantOptions {
  db?: unknown;
  env?: Partial<BoundEnv>;
  accountId?: string;
  settings?: Partial<TenantSettings>;
  cfToken?: string;
  fetch?: typeof fetch;
  mode?: Mode;
}

/** A TenantContext over an in-memory D1, with the usual test reports domain unless overridden. */
export function makeTenant(o: MakeTenantOptions = {}): TenantContext {
  const db = (o.db ?? createMigratedD1()) as D1Database;
  return new TenantContext({
    env: { DB: db, ...o.env } as BoundEnv,
    accountId: o.accountId ?? IMPLICIT_ACCOUNT_ID,
    mode: o.mode,
    settings: {
      reportsDomain: 'reports.test.com',
      fromEmail: 'noreply@reports.test.com',
      ...o.settings,
    },
    cfToken: o.cfToken,
    fetch: o.fetch,
  });
}

/** Store settings for an account the way the wizard does, so loadTenant() sees them. */
export function seedSettings(db: unknown, settings: Record<string, string>, accountId = IMPLICIT_ACCOUNT_ID): void {
  const sqlite = (db as ReturnType<typeof createMigratedD1>).sqlite;
  const stmt = sqlite.prepare('INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  for (const [k, v] of Object.entries(settings)) stmt.run(accountId, k, v);
}
