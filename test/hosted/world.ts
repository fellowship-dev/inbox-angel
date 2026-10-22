// Shared setup for the hosted tests: a saas D1 with two accounts that each own a domain.
import { vi } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import { forAccount } from '@inbox-angel/db';
import type { BoundEnv } from '../../src/index';
import { hashToken, generateToken } from '../../src/hosted/tokens';

export const HOSTED_ENV = {
  MODE: 'saas',
  SAAS_ENABLED: '1',
  INTAKE_DOMAIN: 'rua.inboxangel.io',
  CANARY_DOMAIN: 'canary.inboxangel.io',
  HOSTED_RECORDS_ZONE: 'inboxangel.io',
  HOSTED_RECORDS_LABEL: 'h',
  HOSTED_RECORDS_TOKEN: 'hosted-token',
} as const;

export const NOW = 1_800_000_000;

/** Silence the logs and make every other fetch (IP enrichment DNS) answer NXDOMAIN. */
export function quiet() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

export const nxdomain = () => vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 }));

export async function twoAccounts(extraEnv: Record<string, string> = {}) {
  const db = createMigratedD1();
  for (const id of ['acct_a', 'acct_b']) db.sqlite.prepare('INSERT INTO accounts (id, name) VALUES (?, ?)').run(id, id);
  db.sqlite.prepare("INSERT INTO domains (id, account_id, domain, rua_address) VALUES (1, 'acct_a', 'a-corp.com', 'x')").run();
  db.sqlite.prepare("INSERT INTO domains (id, account_id, domain, rua_address) VALUES (2, 'acct_b', 'b-corp.org', 'x')").run();
  const env = { DB: db as unknown as D1Database, ...HOSTED_ENV, ...extraEnv } as unknown as BoundEnv;
  const tokenA = generateToken();
  const tokenB = generateToken();
  await forAccount(env.DB, 'acct_a').intake.set(1, await hashToken(tokenA), NOW);
  await forAccount(env.DB, 'acct_b').intake.set(2, await hashToken(tokenB), NOW);
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, tokenA, tokenB, rows };
}
