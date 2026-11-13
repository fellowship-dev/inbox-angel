import { describe, expect, it } from 'vitest';
import { createMigratedD1 } from '@inbox-angel/db/testing';
import type { BoundEnv } from '../../src/index';
import { agentAvailability, instancePreflight } from '../../src/setup/preflight';
import { call, inviteAndAccept, makeEnv, setupOwner, type TestDb } from '../auth/helpers';

const ORIGIN = 'https://ia.example.com';
const kv = {} as KVNamespace;
const sendEmail = { send: async () => {} } as unknown as SendEmail;
function env(extra: Record<string, unknown> = {}): BoundEnv {
 const db = createMigratedD1();
 return { DB: db as unknown as D1Database, ...extra } as BoundEnv;
}
const ids = async (e: BoundEnv, origin = ORIGIN) => (await instancePreflight(e, origin)).items.map(i => `${i.severity}:${i.id}`);

describe('instance preflight', () => {
 it('a fully configured self-host instance has nothing to report', async () => {
  const e = env({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail });
  (e.DB as unknown as TestDb).sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.example.com')").run();
  const result = await instancePreflight(e, ORIGIN);
  expect(result).toEqual({ mode: 'self-host', agents: { available: true, server_url: `${ORIGIN}/mcp` }, items: [] });
 });

 it('names each missing self-host setting once, in one result', async () => {
  expect(await ids(env())).toEqual(['action:auth_url', 'action:oauth_storage', 'note:mail_sender']);
  const result = await instancePreflight(env(), ORIGIN);
  expect(result.agents).toEqual({ available: false, server_url: null });
  expect(result.items.find(i => i.id === 'oauth_storage')).toMatchObject({ setting: 'OAUTH_KV', message: expect.stringContaining('agents cannot connect') });
 });

 it('hosted mode needs the bot check and a mail sender to open sign-up, and a booking link for the follow-up email', async () => {
  const hosted = env({ MODE: 'saas', SAAS_ENABLED: '1', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN });
  expect(await ids(hosted)).toEqual(['action:mail_sender', 'action:bot_check', 'note:booking_link']);
  const ready = env({ MODE: 'saas', SAAS_ENABLED: '1', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail, TURNSTILE_SECRET_KEY: 'x', TURNSTILE_SITE_KEY: 'y', BOOKING_URL: 'https://cal.example/max' });
  (ready.DB as unknown as TestDb).sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'base_domain', 'example.com')").run();
  expect(await ids(ready)).toEqual([]);
 });

 it('flags inconsistent settings: an unknown mode, SAAS_ENABLED without saas, one Turnstile key, open client registration, a different address', async () => {
  const odd = env({ MODE: 'hosted', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail, TURNSTILE_SITE_KEY: 'only-one', MCP_DCR_ENABLED: '1' });
  expect(await ids(odd, 'https://other.example.com')).toEqual(['action:mode', 'note:auth_url', 'note:client_registration', 'note:mail_sender', 'action:bot_check']);
  expect(await ids(env({ SAAS_ENABLED: '1', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN }))).toContain('note:mode');
  expect(await ids(env({ OAUTH_KV: kv, BETTER_AUTH_URL: 'http://ia.example.com/path' }))).toContain('action:auth_url');
 });

 it('never includes a configured value, secret or not', async () => {
  const values = {
   BETTER_AUTH_URL: 'http://not-https.example/secret-path', TURNSTILE_SECRET_KEY: 'turnstile-secret-value-123', BOOKING_URL: 'ftp://booking-value.example',
   MODE: 'mode-value-xyz', MCP_DCR_ENABLED: '1', BETTER_AUTH_SECRET: 'auth-secret-value-456', BOOTSTRAP_SECRET: 'bootstrap-secret-value-789', ONBOARDING_SEQUENCE_ENABLED: '1',
  };
  const text = JSON.stringify(await instancePreflight(env(values), ORIGIN));
  for (const v of Object.values(values).filter(v => v !== '1')) expect(text).not.toContain(v);
 });

 it('agents are available only with OAuth storage and a canonical HTTPS address', () => {
  expect(agentAvailability({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN })).toEqual({ available: true, server_url: `${ORIGIN}/mcp` });
  expect(agentAvailability({ BETTER_AUTH_URL: ORIGIN })).toEqual({ available: false, server_url: null });
  expect(agentAvailability({ OAUTH_KV: kv })).toEqual({ available: false, server_url: null });
  expect(agentAvailability({ OAUTH_KV: kv, BETTER_AUTH_URL: 'http://ia.example.com' })).toEqual({ available: false, server_url: null });
 });
});

describe('routes', () => {
 it('GET /api/instance/preflight answers the instance owner and nobody else', async () => {
  const e = makeEnv(undefined, { BETTER_AUTH_URL: ORIGIN, OAUTH_KV: kv });
  const owner = await setupOwner(e);
  const res = await call(e, 'GET', '/api/instance/preflight', { key: owner });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ mode: 'self-host', agents: { available: true, server_url: `${ORIGIN}/mcp` } });
  for (const role of ['admin', 'member'] as const) {
   const token = await inviteAndAccept(e, owner, `${role}@example.com`, role);
   const denied = await call(e, 'GET', '/api/instance/preflight', { key: token });
   expect(denied.status).toBe(403);
   expect(await denied.text()).not.toContain('OAUTH_KV');
  }
  expect((await call(e, 'GET', '/api/instance/preflight')).status).toBe(401);
 });

 it('GET /api/agents/status tells any signed-in member whether agents can connect, without settings names', async () => {
  const e = makeEnv(undefined, {});
  const owner = await setupOwner(e);
  const member = await inviteAndAccept(e, owner, 'member@example.com', 'member');
  const res = await call(e, 'GET', '/api/agents/status', { key: member });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ available: false, server_url: null });
  const ready = makeEnv(undefined, { BETTER_AUTH_URL: ORIGIN, OAUTH_KV: kv });
  const t = await setupOwner(ready);
  expect(await (await call(ready, 'GET', '/api/agents/status', { key: t })).json()).toEqual({ available: true, server_url: `${ORIGIN}/mcp` });
 });
});
