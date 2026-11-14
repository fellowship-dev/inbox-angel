// Local end-to-end run against `wrangler dev --local-protocol https` on :8787 (devbox only, synthetic data).
// Prints statuses and counts only: never the proof, password, cookies or tokens.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const O = 'https://localhost:8787';
const proof = readFileSync('/workspace/ready-set-mail/.dev.vars', 'utf8').match(/BOOTSTRAP_SECRET=(\S+)/)[1];
const PASSWORD = 'local-e2e-password-1';
const jar = new Map();
const keep = (res) => { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
let ipN = 0;
const freshIp = () => `198.51.100.${++ipN}`;
async function f(path, init = {}, withCookie = true) {
 const res = await fetch(O + path, { redirect: 'manual', ...init, headers: { origin: O, 'cf-connecting-ip': '192.0.2.10', ...(withCookie ? { cookie: cookie() } : {}), ...(init.headers || {}) } });
 if (withCookie) keep(res);
 return res;
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const out = {};
const step = (name) => console.error(new Date().toISOString(), name);

let r = await f('/api/auth/setup', { ...json({ email: 'owner@example.com', password: PASSWORD, name: 'Owner' }), headers: { 'content-type': 'application/json', 'x-inbox-angel-bootstrap': proof } });
out.setup = r.status;
if (r.status !== 201) { r = await f('/api/auth/login', json({ email: 'owner@example.com', password: PASSWORD })); out.login = r.status; }
out.preflightIds = (await (await f('/api/instance/preflight')).json()).items.map(i => `${i.severity}:${i.id}`);

const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** Register (with its own IP: registration is limited per IP), consent, token. */
async function connect(name) {
 const ip = freshIp();
 const reg = await f('/oauth/register', { ...json({ client_name: name, redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } }, false);
 const { client_id } = await reg.json();
 const verifier = randomBytes(32).toString('base64url');
 const challenge = createHash('sha256').update(verifier).digest('base64url');
 const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example/callback', scope: 'inbox-angel', resource: O + '/mcp', state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
 const page = await f('/oauth/authorize?' + q);
 const html = await page.text();
 const consent = { status: page.status, heading: html.match(/<h1>(.*?)<\/h1>/)?.[1], preTicked: (html.match(/ checked/g) ?? []).length };
 const handle = html.match(/name="handle" value="([^"]+)"/)[1];
 const form = new URLSearchParams({ handle, days: '7', decision: 'allow' });
 for (const m of html.matchAll(/name="selection" value="([^"]+)"/g)) if (!JSON.parse(unescape(m[1])).productId) form.append('selection', unescape(m[1]));
 for (const a of ['resources:read', 'reports:read', 'diagnostics:run']) form.append('actions', a);
 const approved = await f('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
 const code = new URL(approved.headers.get('location')).searchParams.get('code');
 const token = await f('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri: 'https://client.example/callback', resource: O + '/mcp' }).toString() }, false);
 const tokens = await token.json();
 return { consent, register: reg.status, approve: approved.status, token: token.status, access: tokens.access_token, refresh: tokens.refresh_token, client_id };
}
const ping = (access, ip = '192.0.2.50') => fetch(O + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', 'cf-connecting-ip': ip }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });

step('connect A');
const A = await connect('Agent A test client');
step('connect B');
const B = await connect('Agent B test client');
out.connectA = { consent: A.consent, register: A.register, approve: A.approve, token: A.token };
out.connectB = { register: B.register, approve: B.approve, token: B.token };

// MCP tools through the SDK client, then the live-check budget (counter seeded to 9, as before: workerd here runs out of
// file descriptors after ~6 real DNS checks).
step('mcp');
const transport = new StreamableHTTPClientTransport(new URL(O + '/mcp'), { authProvider: { token: async () => A.access } });
const client = new Client({ name: 'Agent A test client', version: '1.0' });
await client.connect(transport);
const who = await client.callTool({ name: 'whoami', arguments: {} });
const list = await client.callTool({ name: 'list_domains', arguments: {} });
const d = list.structuredContent.data.domains[0];
const report = await client.callTool({ name: 'get_email_report', arguments: { domain: d.domain, workspaceId: d.workspaceId } });
out.mcp = { grants: who.structuredContent.data.grants.length, domains: list.structuredContent.data.domains.map(x => x.domain), report: report.isError ? report.structuredContent.error : 'ok' };
// Parallel: counter seeded to 8 used checks (workerd here runs out of file descriptors after ~6 real DNS checks),
// then 20 calls at once: exactly 2 may pass.
execSync(`npx wrangler d1 execute DB --local --command "UPDATE auth_rate_limits SET count = 8 WHERE key = 'mcp-dns:connection:${who.structuredContent.data.principalId}'"`, { stdio: 'ignore' });
const parallel = await Promise.all(Array.from({ length: 20 }, () => client.callTool({ name: 'inspect_domain', arguments: { domain: d.domain, workspaceId: d.workspaceId } })));
out.parallelDnsChecks = { sent: 20, passed: parallel.filter(r => !r.isError).length, refused: parallel.filter(r => r.isError && r.structuredContent.error.code === 'rate_limited').length };
await client.close();

// Starvation: A at full speed hits its own limit; B in the same workspace still works.
step('starvation');
let sentA = 0, limitedA = null;
while (sentA < 150 && !limitedA) { const res = await ping(A.access); sentA++; if (res.status === 429) limitedA = { after: sentA, retryAfter: res.headers.get('retry-after'), body: await res.json() }; else await res.arrayBuffer(); }
out.connectionLimitA = limitedA;
const firstB = await ping(B.access);
out.secondAgentAfterAIsLimited = firstB.status; await firstB.arrayBuffer();
let sentB = 1, limitedB = null;
while (sentB < 250 && !limitedB) { const res = await ping(B.access); sentB++; if (res.status === 429) limitedB = { after: sentB, body: await res.json() }; else await res.arrayBuffer(); }
out.workspaceLimitViaB = limitedB;

// Per-IP budgets: token-less /mcp 60/min; bad tokens always 401; registrations do not block token requests.
step('anonymous');
const statuses = async (n, url, init) => { const out = {}; for (let i = 0; i < n; i++) { const res = await fetch(O + url, init); out[res.status] = (out[res.status] ?? 0) + 1; await res.arrayBuffer(); } return out; };
out.tokenlessMcp65 = await statuses(65, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.77' }, body: '{}' });
out.badTokenAfterThat20 = await statuses(20, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token', 'cf-connecting-ip': '203.0.113.77' }, body: '{}' });
const regBody = JSON.stringify({ client_name: 'Burst', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' });
out.register12 = await statuses(12, '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.88' }, body: regBody });
// A valid refresh from the address whose registrations are exhausted.
const refreshA = await fetch(O + '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.88' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: A.client_id, refresh_token: A.refresh, resource: O + '/mcp' }).toString() });
out.refreshFromThatAddress = refreshA.status;

// Revoke B, then its token and refresh are refused
step('revoke');
const listed = await (await f('/api/mcp/connections')).json();
const mine = listed.connections.filter(c => !c.revoked).sort((a, b) => b.createdAt - a.createdAt)[0];
out.revoking = { name: mine.name, workspaceName: mine.workspaceName };
out.revoke = (await f(`/api/mcp/connections/${mine.principalId}`, { method: 'DELETE' })).status;
out.afterRevoke = (await ping(B.access, '192.0.2.99')).status;
out.refreshAfterRevoke = (await f('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': freshIp() }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: B.client_id, refresh_token: B.refresh, resource: O + '/mcp' }).toString() }, false)).status;

// Refuse
step('refuse');
const ip = freshIp();
const reg = await f('/oauth/register', { ...json({ client_name: 'Refused client', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }), headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } }, false);
const { client_id } = await reg.json();
const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example/callback', scope: 'inbox-angel', resource: O + '/mcp', state: 's2', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' });
const page = await f('/oauth/authorize?' + q);
const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)[1];
const denied = await f('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'deny' }).toString() });
const to = new URL(denied.headers.get('location'));
out.refuse = { status: denied.status, error: to.searchParams.get('error'), state: to.searchParams.get('state') };
const signedOut = await f('/oauth/authorize?' + q, {}, false);
out.signedOut = { status: signedOut.status, heading: (await signedOut.text()).match(/<h1>(.*?)<\/h1>/)?.[1] };

console.log(JSON.stringify(out, null, 1));
