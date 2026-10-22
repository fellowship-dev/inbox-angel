import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { authSecret } from '../../src/auth/secret';

describe('auth signing secret', () => {
  it('uses BETTER_AUTH_SECRET when set, and stores nothing', async () => {
    const db = createMigratedD1();
    expect(await authSecret({ DB: db as unknown as D1Database, BETTER_AUTH_SECRET: 'from-env' } as any)).toBe('from-env');
    expect(db.sqlite.prepare("SELECT COUNT(*) n FROM settings WHERE key = 'auth_secret'").get()).toEqual({ n: 0 });
  });

  it('otherwise generates one on first use and keeps it in D1 (no extra setup for self-host)', async () => {
    const db = createMigratedD1();
    const env = { DB: db as unknown as D1Database } as any;
    const first = await authSecret(env);
    expect(first.length).toBeGreaterThanOrEqual(43);
    // a fresh isolate (no in-memory cache) reads the same value back
    const row = db.sqlite.prepare("SELECT value FROM settings WHERE key = 'auth_secret'").get() as { value: string };
    expect(row.value).toBe(first);
    expect(await authSecret(env)).toBe(first);
  });

  it('two different databases get different secrets', async () => {
    const a = await authSecret({ DB: createMigratedD1() as unknown as D1Database } as any);
    const b = await authSecret({ DB: createMigratedD1() as unknown as D1Database } as any);
    expect(a).not.toBe(b);
  });
});
