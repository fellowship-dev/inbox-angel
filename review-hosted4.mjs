// PR 145 recheck 3: per-IP budgets, junk-token behaviour, OAuth invariants, two-connection starvation.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const O = 'https://localhost:8787', H = process.env.HOME;
const sec = JSON.parse(readFileSync(H + '/ia-secret.json', 'utf8'));
const out = [];
const log = (name, ok, detail = '') => { out.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const info = (name, detail) => console.log(`INFO | ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
class Jar { constructor() { this.c = new Map(); } header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
 take(res) { for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/max-age=0/i.test(sc) || v === '') this.c.delete(k); else this.c.set(k, v); } } }
async function req(jar, path, { method = 'GET', headers = {}, body, origin = true } = {}) {
 const h = { ...headers }; if (jar && jar.c.size) h.cookie = jar.header(); if (origin && method !== 'GET') h.origin ??= O;
 let res; for (let i = 0; ; i++) { try { res = await fetch(O + path, { method, headers: h, body, redirect: 'manual' }); break; } catch (e) { if (i >= 3) throw e; await sleep(500); } }
 jar?.take(res); return res;
}
const jsonBody = (o) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
const form = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) for (const x of [].concat(v)) p.append(k, x); return { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() }; };
async function mcp(auth, method = 'tools/list') {
 let res; for (let i = 0; ; i++) { try { res = await fetch(O + '/mcp', { method: 'POST', headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) }); break; } catch (e) { if (i >= 3) throw e; await sleep(500); } }
 await res.text(); return res.status;
}
const pkce = () => { const v = randomBytes(32).toString('base64url'); return { v, c: createHash('sha256').update(v).digest('base64url') }; };
const redirect = 'http://127.0.0.1:9999/cb';
const owner = new Jar();
let r = await req(owner, '/api/auth/login', { method: 'POST', ...jsonBody({ email: 'owner@example.com', password: sec.password, cf_turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }) }); info('login', r.status);
r = await req(null, '/oauth/register', { method: 'POST', origin: false, ...jsonBody({ client_name: 'Probe', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
const clientId = (await r.json()).client_id;
const p = pkce(); const url = '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'inbox-angel', resource: O + '/mcp', code_challenge: p.c, code_challenge_method: 'S256', state: 's' });
const h = await (await req(owner, url)).text(); const handle = h.match(/name="handle" value="([^"]+)"/)[1];
const res = await req(owner, '/oauth/authorize', { method: 'POST', ...form({ handle, selection: JSON.stringify({ workspaceId: 'ws_default', domain: 'example.com' }), actions: ['resources:read'], days: '1', decision: 'allow' }) });
const code = new URL(res.headers.get('location')).searchParams.get('code');
const t = await (await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: p.v, resource: O + '/mcp' }) })).json();
info('/mcp with valid token', await mcp(`Bearer ${t.access_token}`));
const pf = await (await req(owner, '/api/instance/preflight')).json(); info('preflight rate_limits item', pf.items.find(i => i.id === 'rate_limits') ?? 'none');
