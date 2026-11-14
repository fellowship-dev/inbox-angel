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
let r = await req(owner, '/api/auth/setup', { method: 'POST', ...jsonBody({ email: 'owner@example.com', password: sec.password, name: 'Owner' }), headers: { 'content-type': 'application/json', 'x-inbox-angel-bootstrap': sec.proof } });
log('owner setup', r.status === 201, String(r.status));
execSync(`npx wrangler d1 execute DB --local --command "INSERT OR IGNORE INTO domains (workspace_id, domain, rua_address) VALUES ('ws_default','example.com','rua@reports.example.test')"`, { cwd: '/workspace/ready-set-mail', stdio: 'pipe' });
r = await req(null, '/oauth/register', { method: 'POST', origin: false, ...jsonBody({ client_name: 'Probe', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
const clientId = (await r.json()).client_id;
const authUrl = (p, extra = {}) => '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'inbox-angel', resource: O + '/mcp', code_challenge: p.c, code_challenge_method: 'S256', state: 's1', ...extra });
for (const [name, q] of [['plain', { code_challenge_method: 'plain' }], ['bad redirect', { redirect_uri: 'https://evil.example/cb' }], ['extra scope', { scope: 'inbox-angel admin' }], ['bad resource', { resource: 'https://evil.example/mcp' }]]) {
 r = await req(owner, authUrl(pkce(), q)); info(`authorize ${name}`, `${r.status} ${(await r.text()).slice(0, 90)}`);
}
async function connect() {
 const p = pkce(); const h = await (await req(owner, authUrl(p))).text(); const handle = h.match(/name="handle" value="([^"]+)"/)[1];
 const res = await req(owner, '/oauth/authorize', { method: 'POST', ...form({ handle, selection: JSON.stringify({ workspaceId: 'ws_default', domain: 'example.com' }), actions: ['resources:read'], days: '1', decision: 'allow' }) });
 const l = new URL(res.headers.get('location'));
 const t = await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'authorization_code', code: l.searchParams.get('code'), redirect_uri: redirect, client_id: clientId, code_verifier: p.v, resource: O + '/mcp' }) });
 return { iss: l.searchParams.get('iss'), state: l.searchParams.get('state'), status: t.status, ...(await t.json()) };
}
const A = await connect(), B = await connect();
info('tokens', { status: A.status, scope: A.scope, expires_in: A.expires_in, refresh: !!A.refresh_token, iss: A.iss, state: A.state });
let n = 0; for (; n < 220; n++) if ((await mcp(`Bearer ${A.access_token}`)) === 429) break;
let bOk = 0; for (let i = 0; i < 20; i++) if ((await mcp(`Bearer ${B.access_token}`)) === 200) bOk++;
log('starvation: A limited at 100, B still works', n === 100 && bOk === 20, `A ok before 429=${n}, B ${bOk}/20`);

await sleep(62000);
const regs = []; for (let i = 0; i < 12; i++) regs.push((await req(null, '/oauth/register', { method: 'POST', origin: false, ...jsonBody({ client_name: 'x', redirect_uris: [redirect], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).status);
info('/oauth/register x12', regs.join(','));
log('/oauth/register 10 per IP', regs.slice(0, 10).every(s => s === 201) && regs[10] === 429, '');
const rf = await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'refresh_token', refresh_token: B.refresh_token, client_id: clientId, resource: O + '/mcp' }) });
const rfj = await rf.json(); log('refresh still works after 10 registrations', rf.status === 200 && rfj.expires_in === 900 && rfj.scope === 'inbox-angel', String(rf.status));
// unauthenticated /mcp: 60 per IP
const anon = []; for (let i = 0; i < 63; i++) anon.push(await mcp(null));
const firstAnon429 = anon.indexOf(429); log('/mcp without token: 60 then 429', firstAnon429 === 60 && anon.slice(0, 60).every(s => s === 401), `first 429 at #${firstAnon429 + 1}`);
// junk tokens: always 401, never counted, even while the anonymous budget is spent
const junk = {}; const shapes = { bearerJunk: 'Bearer junk', bearerOAuthShape: `Bearer ${randomBytes(16).toString('hex')}:${randomBytes(8).toString('hex')}:${randomBytes(16).toString('hex')}`, apiKeyShape: `Bearer ias_${randomBytes(24).toString('hex')}`, notBearer: 'Basic Zm9vOmJhcg==', empty: ' ' };
for (const [k, v] of Object.entries(shapes)) { const s = []; for (let i = 0; i < 80; i++) s.push(await mcp(v)); junk[k] = [...new Set(s)].join('/'); }
info('junk Authorization x80 each, while anonymous budget is spent', junk);
log('presented bad token always 401', Object.values(junk).every(v => v === '401'), '');
log('valid token unaffected', (await mcp(`Bearer ${rfj.access_token}`)) === 200, '');
// /oauth/token 600 per IP
await sleep(62000);
const tok = []; for (let i = 0; i < 603; i++) tok.push((await req(null, '/oauth/token', { method: 'POST', origin: false, ...form({ grant_type: 'refresh_token', refresh_token: 'bogus', client_id: clientId }) })).status);
const first429 = tok.indexOf(429); log('/oauth/token 600 per IP', first429 === 600, `first 429 at #${first429 + 1}; statuses ${[...new Set(tok)].join('/')}`);
console.log('SUMMARY', JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length, failed: out.filter(o => !o.ok).map(o => o.name) }));
