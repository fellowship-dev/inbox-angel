import { describe, expect, it } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import type { BoundEnv } from '../../src/index';
import { agentAvailability, instancePreflight } from '../../src/setup/preflight';
import { call, inviteAndAccept, makeEnv, setupOwner, type TestDb } from '../auth/helpers';

const ORIGIN = 'https://ia.example.com';
const kv = {} as KVNamespace;
const sendEmail = { send: async () => {} } as unknown as SendEmail;
const bound = { limit: async () => ({ success: true }) };
const limiters = { API_LIMITER: bound, AUTH_LIMITER: bound, MCP_LIMITER: bound, OAUTH_TOKEN_LIMITER: bound, MCP_ANON_LIMITER: bound, DNS_PREVIEW_LIMITER: bound };
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
  expect(await ids(hosted)).toEqual(['action:mail_sender', 'action:bot_check', 'action:rate_limits', 'action:intake', 'note:intake', 'note:booking_link']);
  const ready = env({ MODE: 'saas', SAAS_ENABLED: '1', AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar', ...limiters, OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail, TURNSTILE_SECRET_KEY: 'x', TURNSTILE_SITE_KEY: 'y', BOOKING_URL: 'https://cal.example/max', INTAKE_DOMAIN: 'rua.example.com', HOSTED_CONNECT_REPORTS: 'all' });
  (ready.DB as unknown as TestDb).sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'base_domain', 'example.com')").run();
  expect(await ids(ready)).toEqual(['note:intake']); // the one line that always shows HOSTED_CONNECT_REPORTS's current value
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

describe('rate limit bindings', () => {
 it('hosted: every missing ratelimit binding is action needed, in one item, by name', async () => {
  const item = async (extra: Record<string, unknown>) => (await instancePreflight(env({ MODE: 'saas', SAAS_ENABLED: '1', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, ...extra }), ORIGIN)).items.find(i => i.id === 'rate_limits');
  expect(await item({})).toMatchObject({ severity: 'action', setting: 'API_LIMITER, AUTH_LIMITER, MCP_LIMITER, OAUTH_TOKEN_LIMITER, MCP_ANON_LIMITER, DNS_PREVIEW_LIMITER', message: expect.stringContaining('agents are refused until MCP_LIMITER and API_LIMITER are both bound') });
  expect(await item({ API_LIMITER: bound, AUTH_LIMITER: bound, MCP_LIMITER: bound, OAUTH_TOKEN_LIMITER: bound, MCP_ANON_LIMITER: bound })).toMatchObject({ setting: 'DNS_PREVIEW_LIMITER', message: 'A rate limit binding is missing, so the requests it counts are not limited. Add the ratelimit bindings from wrangler.jsonc to this Worker.' });
  expect(await item(limiters)).toBeUndefined();
 });
 it('self-host: missing bindings are not reported (they are optional there)', async () => {
  expect(await ids(env({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail }))).not.toContain('action:rate_limits');
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

describe('report intake findings in the setup check', () => {
 const hosted = (extra: Record<string, unknown> = {}) => env({ MODE: 'saas', SAAS_ENABLED: '1', ...limiters, OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail, TURNSTILE_SECRET_KEY: 'x', TURNSTILE_SITE_KEY: 'y', BOOKING_URL: 'https://cal.example/max', INTAKE_DOMAIN: 'rua.example.com', HOSTED_CONNECT_REPORTS: 'all', ...extra });
 const withSender = (e: BoundEnv) => { (e.DB as unknown as TestDb).sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'base_domain', 'example.com')").run(); return e; };
 const today = () => new Date().toISOString().slice(0, 10);
 const note = (e: BoundEnv, scope: string, n = 1) => (e.DB as unknown as TestDb).sqlite.prepare('INSERT INTO intake_quota (scope, day, messages) VALUES (?, ?, ?)').run(scope, today(), n);
 // The intake findings of PR 151; the line that always shows HOSTED_CONNECT_REPORTS's value is tested in test/hosted/before-all.test.ts.
 const intake = async (e: BoundEnv) => (await instancePreflight(e, ORIGIN)).items.filter(i => i.id === 'intake' && i.setting !== 'HOSTED_CONNECT_REPORTS');

 it('1. AUTHSERV_ID / AUTHSERV_HEADER missing', async () => {
  const items = await intake(withSender(hosted()));
  expect(items).toEqual([{ id: 'intake', severity: 'action', setting: 'AUTHSERV_ID, AUTHSERV_HEADER', message: 'AUTHSERV_ID and AUTHSERV_HEADER are not both set, so no inbound report can be counted: every report is stored but left out of the numbers. Set both after confirming the authserv-id on a message you sent yourself (the Worker logs what it observed, but that is only what an inbound message said).' }]);
 });

 it('2. configured, but inbound mail carries no authentication results', async () => {
  const e = withSender(hosted({ AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' }));
  note(e, 'auth:absent', 4);
  expect(await intake(e)).toEqual([{ id: 'intake', severity: 'action', setting: 'AUTHSERV_HEADER', message: 'Inbound report mail arrived without any authentication results, so no report can be counted. Check that Email Routing adds Authentication-Results (or ARC-Authentication-Results, then set AUTHSERV_HEADER to arc).' }]);
 });

 it('3. configured, but the results name another authserv-id', async () => {
  const e = withSender(hosted({ AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' }));
  note(e, 'auth:foreign', 2);
  expect(await intake(e)).toEqual([{ id: 'intake', severity: 'action', setting: 'AUTHSERV_ID', message: 'Inbound report mail carries authentication results, but not from the AUTHSERV_ID you set, so no report can be counted. Set AUTHSERV_ID after confirming the authserv-id on a message you sent yourself (the Worker logs what it observed, but that is only what an inbound message said).' }]);
 });

 it('4. a storage or daily cap stopped mail recently', async () => {
  const e = withSender(hosted({ AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' }));
  note(e, 'auth:ok', 9);
  note(e, 'cap:cap_instance_storage', 3);
  note(e, 'cap:cap_address_day', 1);
  const [item] = await intake(e);
  expect(item).toMatchObject({ severity: 'note', setting: 'INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY, INTAKE_MAX_INSTANCE_RECORDS' });
  expect(item.message).toBe('In the last 3 days report mail was stopped by a report address\'s daily message limit (INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY); the instance-wide stored-records limit (INTAKE_MAX_INSTANCE_RECORDS). Mail from known reporters was accepted and dropped; other senders were refused. Raise the limit if this is legitimate traffic.');
 });

 it('says nothing when authentication works and no cap was hit, and nothing for a self-host server that counts every report', async () => {
  const e = withSender(hosted({ AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar' }));
  note(e, 'auth:ok', 9);
  expect(await intake(e)).toEqual([]);
  expect(await intake(env({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail }))).toEqual([]); // self-host: REPORT_COUNTING defaults to all
 });
});
