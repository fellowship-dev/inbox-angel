// PR 154 recheck (1b6225b): welcome link, mail cap, pct backfill, closed sign-up. Phases: open | closed.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const require = createRequire('/workspace/ready-set-mail/package.json');
const O = 'https://localhost:8787', H = process.env.HOME, PHASE = 'open';
const sec = JSON.parse(readFileSync(H + '/ia-secret.json', 'utf8'));
const out = [];
const log = (name, ok, detail = '') => { out.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); };
const info = (name, detail) => console.log(`INFO | ${name} | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rows = (s) => JSON.parse(execSync(`npx wrangler d1 execute DB --local --json --command ${JSON.stringify(s)}`, { cwd: '/workspace/ready-set-mail', stdio: 'pipe' }).toString())[0].results;
const wlog = () => readFileSync(`${H}/l/wr-${PHASE}.log`, 'utf8');
class Jar { constructor() { this.c = new Map(); } header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
 take(res) { for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/max-age=0/i.test(sc) || v === '') this.c.delete(k); else this.c.set(k, v); } } }
let ipn = 1; const freshIp = () => `198.51.${100 + Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
async function req(jar, path, { method = 'GET', headers = {}, body, origin = true, ip } = {}) {
 const h = { ...headers }; if (jar && jar.c.size) h.cookie = jar.header(); if (origin && method !== 'GET') h.origin ??= O; h['cf-connecting-ip'] = ip ?? freshIp();
 let res; for (let i = 0; ; i++) { try { res = await fetch(path.startsWith('http') ? path : O + path, { method, headers: h, body, redirect: 'manual' }); break; } catch (e) { if (i >= 3) throw e; await sleep(500); } }
 jar?.take(res); return res;
}
const J = (o) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
const TS = 'XXXX.DUMMY.TOKEN.XXXX';
const authSecret = () => readFileSync('/workspace/ready-set-mail/.dev.vars', 'utf8').match(/BETTER_AUTH_SECRET=(.*)/)[1];
async function mint(email, { secret = authSecret(), expiresIn = 86400 } = {}) { const { createEmailVerificationToken } = await import(require.resolve('better-auth/api')); return createEmailVerificationToken(secret, email, undefined, expiresIn); }
const welcome = (token, password, opts = {}) => req(opts.jar ?? null, '/api/auth/welcome', { method: 'POST', ip: opts.ip, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) }, origin: opts.origin ?? true, body: JSON.stringify({ token, password }) });
const user = (email) => rows(`SELECT u.id, u.name, u.email_verified AS v, (SELECT password FROM auth_accounts a WHERE a.user_id=u.id AND provider_id='credential') AS pw, (SELECT count(*) FROM sessions s WHERE s.user_id=u.id) AS sessions, (SELECT group_concat(w.name, '|') FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=u.id) AS ws FROM users u WHERE email='${email}'`)[0];
const pwA = 'Alpha-' + sec.password, pwB = 'Bravo-' + sec.password;


const sends = () => (wlog().match(/\[auth\] verification email (not sent: (SEND_EMAIL|no sender)|send failed)/g) || []).length;
const caps = () => (wlog().match(/per-address limit reached/g) || []).length;
const snap = () => ({ s: sends(), c: caps() });
const delta = (a) => { const b = snap(); return { sent: b.s - a.s, capped: b.c - a.c }; };
const signup = async (email, extra = {}) => { const r = await req(null, '/api/auth/signup', { method: 'POST', ...J({ email, cf_turnstile_token: TS, ...extra }) }); return `${r.status} ${(await r.text()).slice(0, 60)}`; };
const resend = async (email, tok = TS) => { const r = await req(null, '/api/auth/resend-verification', { method: 'POST', ...J({ email, ...(tok ? { cf_turnstile_token: tok } : {}) }) }); return `${r.status} ${(await r.text()).slice(0, 40)}`; };
const login = async (email, password, opts = {}) => { const t0 = Date.now(); const r = await req(opts.jar ?? null, '/api/auth/login', { method: 'POST', ip: opts.ip, ...J({ email, password, cf_turnstile_token: TS }) }); return { status: r.status, retry: r.headers.get('retry-after'), body: (await r.text()).slice(0, 110), ms: Date.now() - t0 }; };


const rawLogin = async (email, password, { cookie, ip } = {}) => { const r = await req(null, '/api/auth/login', { method: 'POST', ip, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ email, password, cf_turnstile_token: TS }) }); const sc = (r.headers.getSetCookie() || []).find(c => c.startsWith('rsm_device=')); return { status: r.status, device: sc, body: (await r.text()).slice(0, 80) }; };
const lock = async (email) => { const s = []; for (let i = 0; i < 10; i++) s.push((await rawLogin(email, 'wrong-' + i + Math.random())).status); return s.join(','); };
const mk = async (email, pw) => { await signup(email); return (await welcome(await mint(email), pw)).status; };
info('accounts', { a: await mk('deva@example.com', pwA), b: await mk('devb@example.com', pwB) });
const okA = await rawLogin('deva@example.com', pwA); const cookieA = okA.device?.split(';')[0];
info('successful sign-in Set-Cookie (value redacted)', { status: okA.status, attrs: okA.device?.replace(/=[^;]+/, '=<v>') });
const payload = cookieA?.split('=')[1]?.split('.'); info('cookie payload shape', { parts: payload?.length, uidIsUserId: payload?.[0] === rows("SELECT id FROM users WHERE email='deva@example.com'")[0].id, expDays: payload ? Math.round((Number(payload[1]) - Date.now() / 1000) / 86400) : null });
info('failed sign-in sets cookie?', !!(await rawLogin('deva@example.com', 'nope-nope-1')).device);
await signup('unconf@example.com', { password: 'unconf-pass-1' }); const un = await rawLogin('unconf@example.com', 'unconf-pass-1'); info('unconfirmed (403) sets cookie?', { status: un.status, cookie: !!un.device });
info('lock A', await lock('deva@example.com'));
info('A locked, no cookie, right password', (await rawLogin('deva@example.com', pwA)).status);
info('A locked, cookie, WRONG password', (await rawLogin('deva@example.com', 'wrong-x-1', { cookie: cookieA })).status);
info('A locked, cookie, right password', (await rawLogin('deva@example.com', pwA, { cookie: cookieA })).status);
info('lock A again (sign-in cleared it)', await lock('deva@example.com'));
const tampered = cookieA.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
info('A locked, tampered cookie, right password', (await rawLogin('deva@example.com', pwA, { cookie: tampered })).status);
const forgedUid = cookieA.replace(/^rsm_device=[^.]+/, 'rsm_device=' + rows("SELECT id FROM users WHERE email='devb@example.com'")[0].id);
info('lock B', await lock('devb@example.com'));
info('B locked, A cookie, B right password', (await rawLogin('devb@example.com', pwB, { cookie: cookieA })).status);
info('B locked, A cookie with B uid swapped in, B right password', (await rawLogin('devb@example.com', pwB, { cookie: forgedUid })).status);
// per-IP limit still applies with the cookie
const ip = freshIp(); const per = []; for (let i = 0; i < 12; i++) per.push((await rawLogin('deva@example.com', 'wrong-ip-' + i, { cookie: cookieA, ip })).status);
info('A cookie, 12 wrong from one IP', per.join(','));
// password reset, then is the OLD cookie still useful?
{ const r = await req(null, '/api/auth/forgot', { method: 'POST', ...J({ email: 'deva@example.com' }) }); const t = rows("SELECT identifier FROM verifications WHERE identifier LIKE 'reset-password:%' ORDER BY rowid DESC LIMIT 1")[0];
  const rr = await req(null, '/api/auth/reset', { method: 'POST', ...J({ token: t.identifier.split(':')[1], password: 'Reset-' + pwA }) }); info('password reset', { forgot: r.status, reset: rr.status }); }
info('lock A after reset', await lock('deva@example.com'));
info('A locked, OLD cookie (pre-reset), new password', (await rawLogin('deva@example.com', 'Reset-' + pwA, { cookie: cookieA })).status);
// revoke all sessions, old cookie still useful?
{ const j = new Jar(); await req(j, '/api/auth/login', { method: 'POST', ...J({ email: 'deva@example.com', password: 'Reset-' + pwA, cf_turnstile_token: TS }) });
  const rv = await req(j, '/api/auth/revoke-sessions', { method: 'POST', ...J({}) }); info('revoke-sessions', rv.status); }
info('lock A after revoke', await lock('deva@example.com'));
info('A locked, OLD cookie (pre-reset, pre-revoke), password', (await rawLogin('deva@example.com', 'Reset-' + pwA, { cookie: cookieA })).status);
rows("INSERT INTO auth_rate_limits (id, key, count, last_request) VALUES ('zz1','zz-old',5, CAST(strftime('%s','now') AS INTEGER)*1000 - 3*86400000), ('zz2','zz-live-day',5, CAST(strftime('%s','now') AS INTEGER)*1000 - 23*3600000)");
for (let i = 0; i < 60; i++) await rawLogin('spray-' + i + '@example.com', 'x-x-x-x');
info('sweep after 60 failed sign-ins', rows("SELECT key FROM auth_rate_limits WHERE key LIKE 'zz-%'").map(r => r.key));
info('sweep: rows older than 2 days', rows("SELECT count(*) AS n FROM auth_rate_limits WHERE last_request < (strftime('%s','now')*1000 - 172800000)")[0]);
console.log('DONE');
