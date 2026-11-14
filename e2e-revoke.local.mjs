// Local end-to-end run against `wrangler dev --local-protocol https` on :8787 (devbox only, synthetic data).
// Prints statuses and counts only: never the proof, password, cookies or tokens.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const O = 'https://localhost:8787';
const proof = readFileSync('/workspace/ready-set-mail/.dev.vars', 'utf8').match(/BOOTSTRAP_SECRET=(\S+)/)[1];
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
const reg = await f('/oauth/register', json({ client_name: 'Revoke test client', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }), false);
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
const ping = () => fetch(O + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
out.beforeRevoke = (await ping()).status;
const listed = await (await f('/api/mcp/connections')).json();
const mine = listed.connections.filter(c => !c.revoked).sort((a, b) => b.createdAt - a.createdAt)[0];
out.revoking = { name: mine.name, workspaceName: mine.workspaceName };
out.revoke = (await f(`/api/mcp/connections/${mine.principalId}`, { method: 'DELETE' })).status;
out.afterRevoke = (await ping()).status;
const refresh = await f('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token, resource: O + '/mcp' }).toString() }, false);
out.refreshAfterRevoke = refresh.status;
console.log(JSON.stringify(out, null, 1));
