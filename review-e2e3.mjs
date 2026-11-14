// PR 145 recheck (head e064453). Phases: selfhost | hosted-missing | hosted-full | selfhost-missing.
// Prints results only; never prints secrets, tokens or cookies.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const O = 'https://localhost:8787', PHASE = process.argv[2];
const H = process.env.HOME;
const sec = JSON.parse(readFileSync(H + '/ia-secret.json', 'utf8'));
const out = [];
const log = (name, ok, detail = '') => { out.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const info = (name, detail) => console.log(`INFO | ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sql = (s) => execSync(`npx wrangler d1 execute DB --local ${process.env.WCFG ? '-c ' + process.env.WCFG : ''} --command ${JSON.stringify(s)}`, { cwd: '/workspace/ready-set-mail', stdio: 'pipe' }).toString();
class Jar { constructor() { this.c = new Map(); } header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
 take(res) { for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc) || v === '') this.c.delete(k); else this.c.set(k, v); } } }
async function req(jar, path, { method = 'GET', headers = {}, body, origin = true } = {}) {
 const h = { ...headers }; if (jar && jar.c.size) h.cookie = jar.header(); if (origin && method !== 'GET') h.origin ??= O;
 let res; for (let i = 0; ; i++) { try { res = await fetch(path.startsWith('http') ? path : O + path, { method, headers: h, body, redirect: 'manual' }); break; } catch (e) { if (i >= 3) throw e; await sleep(500); } }
 jar?.take(res); return res;
}
const jsonBody = (o) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
const form = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) for (const x of [].concat(v)) p.append(k, x); return { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() }; };
async function mcp(token, method, params = {}) {
 let res; for (let i = 0; ; i++) { try { res = await fetch(O + '/mcp', { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); break; } catch (e) { if (i >= 3) throw e; await sleep(500); } }
 const text = await res.text(); let body = null; try { body = JSON.parse(text.includes('data:') ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop() : text); } catch {}
 return { status: res.status, retry: res.headers.get('retry-after'), body, text };
}
const pkce = () => { const v = randomBytes(32).toString('base64url'); return { v, c: createHash('sha256').update(v).digest('base64url') }; };
const redirect = 'http://127.0.0.1:9999/cb';
const owner = new Jar();

if (PHASE !== 'selfhost') {
 const r = await req(owner, '/api/auth/login', { method: 'POST', ...jsonBody({ email: 'owner@example.com', password: sec.password, cf_turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }) }); info(`${PHASE} login`, r.status);
 const tok = JSON.parse(readFileSync(H + '/ia-token.json', 'utf8'));
 // refresh first (the access token lives 15 minutes)
 const rf = await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: tok.client, resource: O + '/mcp' }) });
 const rt = await rf.json(); if (rt.refresh_token) writeFileSync(H + '/ia-token.json', JSON.stringify({ ...tok, refresh: rt.refresh_token }), { mode: 0o600 });
 info(`${PHASE} refresh`, { status: rf.status, scope: rt.scope, expires_in: rt.expires_in });
 const m = await mcp(rt.access_token, 'tools/list');
 info(`${PHASE} /mcp with valid token`, `${m.status} retry=${m.retry} ${m.text.slice(0, 200)}`);
 const p = await req(owner, '/api/instance/preflight'); const pt = await p.text();
 info(`${PHASE} preflight`, `${p.status} ${pt.slice(0, 900)}`);
 const me = await req(owner, '/api/me'); const mt = await me.text(); info(`${PHASE} /api/me keys`, `${me.status} instance_owner=${/"instance_owner":true/.test(mt)} dns_preview_limiter=${mt.includes('dns_preview_limiter')}`);
 console.log('SUMMARY', JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length }));
 process.exit(0);
}

// ---------- selfhost phase ----------
let r = await req(owner, '/api/auth/setup', { method: 'POST', ...jsonBody({ email: 'owner@example.com', password: sec.password, name: 'Owner' }), headers: { 'content-type': 'application/json', 'x-inbox-angel-bootstrap': sec.proof } });
log('owner setup 201', r.status === 201, String(r.status));
sql(`UPDATE workspaces SET name='Acme \"><img src=x onerror=alert(1)>' WHERE id='ws_default'`);
sql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('ws_default','example.com','rua@reports.example.test')`);
sql(`INSERT OR IGNORE INTO workspaces (id,name) VALUES ('ws_other','Other company')`);
sql(`INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('ws_other','victim.com','rua@reports.example.test')`);

const HOSTILE = `Claude"><script>alert(1)</script>`;
r = await req(null, '/oauth/register', { method: 'POST', origin: false, ...jsonBody({ client_name: HOSTILE, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
const clientId = (await r.json()).client_id; info('register DCR client', r.status);
const authUrl = (cid, p, ru = redirect) => '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: cid, redirect_uri: ru, scope: 'inbox-angel', resource: O + '/mcp', code_challenge: p.c, code_challenge_method: 'S256', state: 'st-' + randomBytes(4).toString('hex') });
for (const [name, q] of [['plain method', { code_challenge_method: 'plain' }], ['unregistered redirect', { redirect_uri: 'https://evil.example/cb' }], ['extra scope', { scope: 'inbox-angel admin' }], ['wrong resource', { resource: 'https://evil.example/mcp' }]]) {
 const u = new URL(O + authUrl(clientId, pkce())); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
 r = await req(owner, u.pathname + u.search); info(`authorize ${name}`, `${r.status} ${(await r.text()).slice(0, 110)}`);
}
async function consent(cid = clientId, ru = redirect) { const p = pkce(); const url = authUrl(cid, p, ru); const res = await req(owner, url); const h = await res.text(); return { res, h, handle: (h.match(/name="handle" value="([^"]+)"/) || [])[1], p, state: new URL(O + url).searchParams.get('state') }; }
let c = await consent();
const h1 = (c.h.match(/<h1>(.*?)<\/h1>/) || [])[1];
log('unverified: generic heading', h1 === 'An app is asking to work with your domains', h1);
log('unverified: claimed name shown, escaped, marked not verified, redirect host shown', c.h.includes('Name it gives') && c.h.includes('Claude&quot;&gt;&lt;script&gt;') && /Not verified/.test(c.h) && c.h.includes('127.0.0.1'), '');
log('unverified: nothing pre-ticked', !/ checked>/.test(c.h) && !/" checked/.test(c.h), (c.h.match(/checked/g) || []).length + ' checked attrs');
log('unverified: no script, CSP + XFO', !/<script/i.test(c.h) && /frame-ancestors 'none'/.test(c.res.headers.get('content-security-policy') || '') && c.res.headers.get('x-frame-options') === 'DENY', '');
log('copy: DNS provider wording', c.h.includes('in the dashboard or at your DNS provider'), '');
log('44px on touch', c.h.includes('@media (pointer:coarse){select,input[type=text]{height:44px}}'), '');

// verified (Client ID Metadata Document) client: a real public CIMD URL
const CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
try {
 const doc = await (await fetch(CIMD)).json(); info('CIMD doc', { client_id: doc.client_id, redirect_uris: doc.redirect_uris, client_name: doc.client_name });
 const ru = (doc.redirect_uris || [])[0];
 const v = await consent(doc.client_id, ru);
 info('verified consent', { status: v.res.status, h1: (v.h.match(/<h1>(.*?)<\/h1>/) || [])[1], publishedBy: (v.h.match(/Published by<\/strong> <span class="mono">([^<]+)/) || [])[1], checked: [...v.h.matchAll(/name="(\w+)" value="([^"]+)" ?checked/g)].map(m => m[2].replace(/&quot;/g, '"')), body: v.res.status !== 200 ? v.h.slice(0, 200) : '' });
} catch (e) { info('CIMD fetch failed', String(e)); }

// crafted POSTs, each on a fresh handle
const sel = JSON.stringify({ workspaceId: 'ws_default', domain: 'example.com' });
const base = { selection: sel, actions: ['resources:read', 'reports:read'], days: '7', decision: 'allow' };
const crafted = [
 ['access:manage added', { ...base, actions: ['resources:read', 'access:manage'] }], ['unknown action', { ...base, actions: ['admin:all'] }], ['no actions', { ...base, actions: [] }],
 ['other workspace domain', { ...base, selection: JSON.stringify({ workspaceId: 'ws_other', domain: 'victim.com' }) }],
 ['new domain in other ws', { ...base, selection: [], workspaceId: 'ws_other', domain: 'newone.com' }],
 ['days=31', { ...base, days: '31' }], ['days=0', { ...base, days: '0' }], ['days=1.5', { ...base, days: '1.5' }],
 ['101 selections', { ...base, selection: Array.from({ length: 101 }, () => sel) }], ['malformed JSON', { ...base, selection: '{bad' }],
 ['special-use new domain', { ...base, selection: [], workspaceId: 'ws_default', domain: 'foo.localhost' }],
];
for (const [name, f] of crafted) { const k = await consent(); r = await req(owner, '/oauth/authorize', { method: 'POST', ...form({ ...f, handle: k.handle }) }); log(`crafted POST rejected: ${name}`, r.status >= 400 && r.status < 500, String(r.status)); }
c = await consent();
for (const [name, opts] of [['no Origin', { origin: false, ...form({ ...base, handle: c.handle }) }], ['cross-site Origin', { body: form({ ...base, handle: c.handle }).body, headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } }], ['cross-site deny', { body: form({ handle: c.handle, decision: 'deny' }).body, headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } }]]) {
 r = await req(owner, '/oauth/authorize', { method: 'POST', ...opts }); log(`CSRF: ${name} rejected`, r.status === 403, String(r.status));
}
const stranger = new Jar(); for (const [k, v] of owner.c) if (!k.startsWith('__Host-oauth')) stranger.c.set(k, v);
r = await req(stranger, '/oauth/authorize', { method: 'POST', ...form({ ...base, handle: c.handle }) }); log('handle without binding cookie rejected', r.status >= 400, String(r.status));
r = await req(owner, '/oauth/authorize', { method: 'POST', ...form({ handle: c.handle, decision: 'deny' }) }); const lu = new URL(r.headers.get('location'));
log('deny: access_denied + state + iss', r.status === 302 && lu.searchParams.get('error') === 'access_denied' && lu.searchParams.get('state') === c.state && !!lu.searchParams.get('iss'), String(r.status));

// two connections (token calls count against the per-IP oauth budget: 2 here + 1 register above)
async function connect() {
 const k = await consent(); const res = await req(owner, '/oauth/authorize', { method: 'POST', ...form({ ...base, actions: ['resources:read', 'reports:read'], handle: k.handle }) });
 const code = new URL(res.headers.get('location')).searchParams.get('code');
 const t = await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: k.p.v, resource: O + '/mcp' }) });
 return { status: t.status, ...(await t.json()) };
}
const A = await connect(), B = await connect();
info('tokens', { A: A.status, B: B.status, scope: A.scope, expires_in: A.expires_in, refresh: !!A.refresh_token });
writeFileSync(H + '/ia-token.json', JSON.stringify({ client: clientId, refresh: B.refresh_token }), { mode: 0o600 });
let n = 0, hit = null; for (; n < 230; n++) { const x = await mcp(A.access_token, 'tools/list'); if (x.status === 429) { hit = x; break; } }
info('connection A burst', { okBefore429: n, retry: hit?.retry, body: hit?.text?.slice(0, 120) });
let bOk = 0; for (let i = 0; i < 20; i++) if ((await mcp(B.access_token, 'tools/list')).status === 200) bOk++;
log('starvation fixed: connection B still works after A is limited', bOk === 20, `${bOk}/20 ok`);
r = await req(owner, '/api/me'); log('dashboard unaffected', r.status === 200, String(r.status));

// per-IP limits (AUTH_LIMITER 10/min, key oauth:<ip>)
info('waiting', '65 s for the per-IP window'); await sleep(65000);
const seq = async (fn, k) => { const s = []; for (let i = 0; i < k; i++) s.push(await fn()); return s; };
const reg = await seq(async () => (await req(null, '/oauth/register', { method: 'POST', origin: false, ...jsonBody({ client_name: 'x', redirect_uris: [redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).status, 12);
info('/oauth/register x12', reg.join(','));
log('/oauth/register limited per IP', reg.slice(0, 10).every(s => s === 201) && reg[10] === 429, '');
const validAfter = await mcp(A.access_token, 'tools/list'); info('valid-token /mcp while per-IP oauth budget is spent', validAfter.status);
const tokenRefreshWhileSpent = await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'refresh_token', refresh_token: A.refresh_token, client_id: clientId }) });
info('refresh from same IP while budget spent', tokenRefreshWhileSpent.status);
await sleep(65000);
const anon = await seq(async () => (await mcp(null, 'tools/list')).status, 12); info('/mcp without token x12', anon.join(','));
log('/mcp without token limited per IP', anon.slice(0, 10).every(s => s === 401) && anon[10] === 429, '');
await sleep(65000);
const badTok = await seq(async () => { const x = await mcp('expired-or-invalid', 'tools/list'); return `${x.status}${x.status === 429 ? '' : ''}`; }, 12); info('/mcp with invalid token x12', badTok.join(','));
await sleep(65000);
const tok = await seq(async () => (await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'refresh_token', refresh_token: 'bogus', client_id: clientId }) })).status, 12); info('/oauth/token x12 (bogus refresh)', tok.join(','));
log('/oauth/token limited per IP', tok[10] === 429, '');
await sleep(65000);
console.log('SUMMARY', JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length, failed: out.filter(o => !o.ok).map(o => o.name) }));
