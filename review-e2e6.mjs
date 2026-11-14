// PR 154: consent POST header matrix (scripted), Referrer-Policy, OAuth invariants. Needs the verified new@example.com.
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const O = 'https://localhost:8787', H = process.env.HOME;
const sec = JSON.parse(readFileSync(H + '/ia-secret.json', 'utf8'));
const info = (name, detail) => console.log(`INFO | ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
class Jar { constructor() { this.c = new Map(); } header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
 take(res) { for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/max-age=0/i.test(sc) || v === '') this.c.delete(k); else this.c.set(k, v); } } }
let ipn = 1; const ip = () => `203.0.113.${ipn++}`;
async function req(jar, path, { method = 'GET', headers = {}, body } = {}) {
 const h = { 'cf-connecting-ip': ip(), ...headers }; if (jar && jar.c.size) h.cookie = jar.header();
 const res = await fetch(O + path, { method, headers: h, body, redirect: 'manual' }); jar?.take(res); return res;
}
const owner = new Jar();
let r = await req(owner, '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: O }, body: JSON.stringify({ email: 'new@example.com', password: sec.password, cf_turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }) });
info('login', r.status);
const me = await (await req(owner, '/api/me')).json(); const ws = me.workspace_id; info('workspace', ws ? 'yes' : 'no');
r = await req(null, '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Probe', redirect_uris: ['http://127.0.0.1:9999/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
const clientId = (await r.json()).client_id;
const pkce = () => { const v = randomBytes(32).toString('base64url'); return { v, c: createHash('sha256').update(v).digest('base64url') }; };
const authUrl = (p, extra = {}) => '/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:9999/cb', scope: 'ready-set-mail', resource: O + '/mcp', code_challenge: p.c, code_challenge_method: 'S256', state: 's1', ...extra });
for (const [n, q] of [['plain', { code_challenge_method: 'plain' }], ['bad redirect', { redirect_uri: 'https://evil.example/cb' }], ['extra scope', { scope: 'ready-set-mail admin' }], ['bad resource', { resource: 'https://evil.example/mcp' }]]) { r = await req(owner, authUrl(pkce(), q)); info(`authorize ${n}`, r.status); }
async function consent() { const p = pkce(); const res = await req(owner, authUrl(p)); const h = await res.text(); return { res, h, p, handle: (h.match(/name="handle" value="([^"]+)"/) || [])[1] }; }
const c0 = await consent();
info('consent headers', { status: c0.res.status, referrerPolicy: c0.res.headers.get('referrer-policy'), csp: c0.res.headers.get('content-security-policy'), xfo: c0.res.headers.get('x-frame-options') });
const cases = { 'Origin same-origin': { origin: O }, 'Origin foreign': { origin: 'https://evil.example' }, 'Origin null': { origin: 'null' }, 'no Origin, same-origin Referer': { referer: O + '/oauth/authorize?x=1' }, 'no Origin, no Referer': {} };
for (const decision of ['allow', 'deny']) for (const [name, hdr] of Object.entries(cases)) {
 const k = await consent();
 const body = new URLSearchParams({ handle: k.handle, decision, days: '1', workspaceId: ws, domain: 'example.org' }); body.append('actions', 'resources:read');
 const res = await req(owner, '/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...hdr }, body: body.toString() });
 const loc = res.headers.get('location') || '';
 info(`${decision} | ${name}`, `${res.status}${loc ? ' -> ' + loc.replace(/code=[^&]+/, 'code=<code>') : ''}${res.headers.get('referrer-policy') ? ' rp=' + res.headers.get('referrer-policy') : ''}`);
 if (decision === 'allow' && res.status === 302 && name === 'Origin same-origin') {
  const code = new URL(loc).searchParams.get('code');
  const t = await (await req(null, '/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9999/cb', client_id: clientId, code_verifier: k.p.v, resource: O + '/mcp' }).toString() })).json();
  info('token', { scope: t.scope, expires_in: t.expires_in, refresh: !!t.refresh_token });
 }
}
