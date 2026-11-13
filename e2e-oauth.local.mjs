// Local end-to-end run against `wrangler dev --local-protocol https` on :8787 (devbox only, synthetic data).
// Prints statuses and counts only: never the proof, password, cookies or tokens.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const O = 'https://localhost:8787';
const proof = readFileSync('/workspace/inbox-angel/.dev.vars', 'utf8').match(/BOOTSTRAP_SECRET=(\S+)/)[1];
const PASSWORD = 'local-e2e-password-1';
const jar = new Map();
const keep = (res) => { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function f(path, init = {}, withCookie = true) {
 const res = await fetch(O + path, { redirect: 'manual', ...init, headers: { origin: O, ...(withCookie ? { cookie: cookie() } : {}), ...(init.headers || {}) } });
 if (withCookie) keep(res);
 return res;
}
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const out = {};
const step = (name) => console.error(new Date().toISOString(), name, JSON.stringify(out).length);

// Owner
let r = await f('/api/auth/setup', { ...json({ email: 'owner@example.com', password: PASSWORD, name: 'Owner' }), headers: { 'content-type': 'application/json', 'x-inbox-angel-bootstrap': proof } });
out.setup = r.status;
if (r.status !== 201) { r = await f('/api/auth/login', json({ email: 'owner@example.com', password: PASSWORD })); out.login = r.status; }
out.preflight = await (await f('/api/instance/preflight')).json();
out.agentsStatus = await (await f('/api/agents/status')).json();

step('Client registration');
// Client registration (DCR is on only in this local .dev.vars, to script a client)
const reg = await f('/oauth/register', json({ client_name: 'Scripted test client', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), false);
out.register = reg.status;
const { client_id } = await reg.json();
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorizeQuery = (state) => new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example/callback', scope: 'inbox-angel', resource: O + '/mcp', state, code_challenge: challenge, code_challenge_method: 'S256' });

step('Signed out');
// Signed out
const anon = await f('/oauth/authorize?' + authorizeQuery('s0'), {}, false);
out.signedOut = { status: anon.status, csp: !!anon.headers.get('content-security-policy'), heading: (await anon.text()).match(/<h1>(.*?)<\/h1>/)?.[1] };

step('Consent');
// Consent
const page = await f('/oauth/authorize?' + authorizeQuery('s1'));
const html = await page.text();
const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const selections = [...html.matchAll(/name="selection" value="([^"]+)"/g)].map(m => unescape(m[1])).filter(v => !JSON.parse(v).productId);
out.consent = { status: page.status, heading: html.match(/<h1>(.*?)<\/h1>/)?.[1], groups: [...html.matchAll(/<p class="group-name">(.*?)<\/p>/g)].map(m => m[1]), domains: selections.length, rawWorkspaceIdVisible: html.replace(/<[^>]*>/g, ' ').includes('ws_') };
const handle = html.match(/name="handle" value="([^"]+)"/)[1];
const form = new URLSearchParams({ handle, days: '7', decision: 'allow' });
for (const s of selections) form.append('selection', s);
for (const a of ['resources:read', 'reports:read', 'diagnostics:run']) form.append('actions', a);
const approved = await f('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
const location = new URL(approved.headers.get('location'));
out.approve = { status: approved.status, redirectedTo: location.origin + location.pathname, hasCode: !!location.searchParams.get('code'), state: location.searchParams.get('state') };

step('Token');
// Token
const token = await f('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id, code: location.searchParams.get('code'), code_verifier: verifier, redirect_uri: 'https://client.example/callback', resource: O + '/mcp' }).toString() }, false);
const tokens = await token.json();
out.token = { status: token.status, expiresIn: tokens.expires_in, hasRefresh: !!tokens.refresh_token };

step('MCP calls');
// MCP calls through the SDK client
const transport = new StreamableHTTPClientTransport(new URL(O + '/mcp'), { authProvider: { token: async () => tokens.access_token } });
const client = new Client({ name: 'Scripted test client', version: '1.0' });
await client.connect(transport);
const who = await client.callTool({ name: 'whoami', arguments: {} });
const list = await client.callTool({ name: 'list_domains', arguments: {} });
const domains = list.structuredContent.data.domains.map(d => d.domain);
step('report');
const report = await client.callTool({ name: 'get_email_report', arguments: { domain: domains[0], workspaceId: list.structuredContent.data.domains[0].workspaceId } });
out.mcp = { whoamiGrants: who.structuredContent.data.grants.length, domains, report: report.isError ? report.structuredContent.error : report.structuredContent.summary };

step('DNS-check budget');
// DNS-check budget: keep asking for reports until refused
// workerd in this devbox runs out of file descriptors (hard limit 1024) after ~6 full DNS checks, so instead of
// spending 9 more real checks, the D1 counter is set to 9 used checks; checks 10 and 11 then go through the real path.
const principal = who.structuredContent.data.principalId;
execSync(`npx wrangler d1 execute DB --local --command "UPDATE auth_rate_limits SET count = 9 WHERE key = 'mcp-dns:connection:${principal}'"`, { stdio: 'ignore' });
let refused = null;
for (let n = 10; n <= 11; n++) {
 const res = await client.callTool({ name: 'inspect_domain', arguments: { domain: domains[0], workspaceId: list.structuredContent.data.domains[0].workspaceId } });
 step('dns ' + n + ' ' + (res.isError ? 'err' : 'ok'));
 if (res.isError) refused = { check: n, error: res.structuredContent.error };
}
out.dnsBudget = refused;
await client.close();

step('HTTP request limit');
// HTTP request limit: raw pings until 429
let sent = 0, limited = null;
while (sent < 260 && !limited) {
 const res = await fetch(O + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: sent, method: 'ping' }) });
 sent++;
 if (res.status === 429) limited = { afterRequests: sent, retryAfter: res.headers.get('retry-after'), body: await res.json() };
 else await res.arrayBuffer();
}
out.requestLimit = limited;

step('Revoke');
// Revoke
const listed = await (await f('/api/mcp/connections')).json();
out.connections = listed.connections.map(c => ({ name: c.name, workspaceName: c.workspaceName, revoked: c.revoked }));
const revoke = await f(`/api/mcp/connections/${listed.connections[0].principalId}`, { method: 'DELETE' });
out.revoke = revoke.status;
const after = await fetch(O + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
out.afterRevoke = after.status;

step('Refuse');
// Refuse
const page2 = await f('/oauth/authorize?' + authorizeQuery('s2'));
const handle2 = (await page2.text()).match(/name="handle" value="([^"]+)"/)[1];
const denied = await f('/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle: handle2, decision: 'deny' }).toString() });
const deniedTo = new URL(denied.headers.get('location'));
out.refuse = { status: denied.status, error: deniedTo.searchParams.get('error'), state: deniedTo.searchParams.get('state'), iss: deniedTo.searchParams.get('iss') };

console.log(JSON.stringify(out, null, 1));
