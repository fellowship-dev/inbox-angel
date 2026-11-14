// PR 154 recheck (1b6225b): welcome link, mail cap, pct backfill, closed sign-up. Phases: open | closed.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const require = createRequire('/workspace/ready-set-mail/package.json');
const O = 'https://localhost:8787', H = process.env.HOME, PHASE = process.argv[2];
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

if (PHASE === 'open') {
 // ---- mail allowances ----
 info('resend without bot token (keys present)', await resend('x@example.com', null));
 let a = snap(); const seq = [];
 seq.push('attacker signup ' + await signup('victim1@example.com', { name: 'Support: call +1 555 0100', password: 'attacker-pass-1' }));
 for (let i = 0; i < 5; i++) seq.push('attacker resend ' + await resend('victim1@example.com'));
 await sleep(1200); info('attacker: signup + 5 resends', { seq, ...delta(a) });
 a = snap(); const vs = await signup('victim1@example.com'); await sleep(1200); info('victim signs up afterwards', { response: vs, ...delta(a) });
 // reverse: burn the sign-up allowance
 a = snap(); const s2 = []; for (let i = 0; i < 4; i++) s2.push(await signup('victim2@example.com')); await sleep(1200); info('attacker signs victim2 up 4 times', { s2, ...delta(a) });
 a = snap(); const v2 = await signup('victim2@example.com'); await sleep(1200); info('victim2 own sign-up after that', { response: v2, ...delta(a) });
 a = snap(); const v2r = await resend('victim2@example.com'); await sleep(1200); info('victim2 presses Resend', { response: v2r, ...delta(a) });
 info('responses for a never-registered address', { signup: await signup('fresh-' + Date.now() + '@example.com'), resend: await resend('nobody-' + Date.now() + '@example.com') });
 const verified = 'verified@example.com'; await signup(verified); { const r = await welcome(await mint(verified), pwA); info('verified@ welcome', r.status); }
 a = snap(); info('sign-up again with a confirmed address', { response: await signup(verified), resend: await resend(verified) }); await sleep(1200); info('mails for confirmed address', delta(a));
 info('stored mail-cap keys', rows("SELECT key FROM auth_rate_limits WHERE key LIKE 'verify-mail:%' ORDER BY key LIMIT 4").map(r => r.key));

 // ---- names ----
 const v1 = user('victim1@example.com'); info('victim1 before welcome (attacker typed a name)', { name: v1.name, ws: v1.ws });
 const evil = 'A‮evil​\u0007\nname ' + 'x'.repeat(120);
 let r = await welcome(await mint('victim1@example.com'), pwA, { jar: new Jar() });
 info('victim1 welcome with no name', r.status);
 const v1b = user('victim1@example.com'); info('victim1 after welcome', { name: v1b.name, ws: v1b.ws });
 r = await req(null, '/api/auth/login', { method: 'POST', ...J({ email: 'victim1@example.com', password: 'attacker-pass-1', cf_turnstile_token: TS }) }); log('attacker password dead', r.status === 401, String(r.status));
 await signup('named@gmail.com');
 r = await req(null, '/api/auth/welcome', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mint('named@gmail.com'), password: pwA, name: evil }) });
 const n = user('named@gmail.com'); info('welcome with a hostile name', { status: r.status, name: JSON.stringify(n.name), len: [...n.name].length, ws: JSON.stringify(n.ws) });
 await signup('blank@gmail.com');
 r = await req(null, '/api/auth/welcome', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mint('blank@gmail.com'), password: pwA, name: ' ​‮\t ' }) });
 const b = user('blank@gmail.com'); info('welcome with whitespace/invisible-only name', { status: r.status, name: b.name, ws: b.ws });
 // hosted invite: name ignored
 const inviter = new Jar(); await req(inviter, '/api/auth/login', { method: 'POST', ...J({ email: 'named@gmail.com', password: pwA, cf_turnstile_token: TS }) });
 r = await req(inviter, '/api/team/invite', { method: 'POST', ...J({ email: 'invitee@example.com', role: 'member' }) }); const inv = await r.json();
 r = await req(null, `/api/invites/${inv.token}`, { method: 'POST', ...J({ name: 'Support: call +1 555 0199', password: 'invitee-pass-1' }) }); info('hosted invite accept with a typed name', `${r.status} ${(await r.text()).slice(0, 80)}`);
 const iv = user('invitee@example.com'); info('invitee before welcome', { name: iv?.name, ws: iv?.ws });
 r = await req(inviter, '/api/team'); info('members list as the inviter sees it', (await r.text()).slice(0, 300));

 // ---- sign-in throttle ----
 const ok = 'thr@example.com'; await signup(ok); await welcome(await mint(ok), pwB);
 const fails = []; for (let i = 0; i < 11; i++) fails.push((await login(ok, 'wrong-' + i)).status);
 info('11 wrong passwords, each from a new IP', fails.join(','));
 const right = await login(ok, pwB); info('right password while throttled', right);
 const unk = []; for (let i = 0; i < 11; i++) unk.push((await login('ghost-' + 'z@example.com', 'wrong-' + i)).status); const unkLast = await login('ghost-z@example.com', 'x-1');
 info('unknown address: 11 wrong then one more', { statuses: unk.join(','), last: unkLast });
 // timing: known vs unknown, wrong password, fresh addresses
 await signup('t1@example.com'); await welcome(await mint('t1@example.com'), pwA);
 const tk = [], tu = []; for (let i = 0; i < 8; i++) { tk.push((await login('t1@example.com', 'nope-' + i)).ms); tu.push((await login('nobody-t@example.com', 'nope-' + i)).ms); }
 const med = (xs) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)];
 info('timing wrong password: known vs unknown (median ms)', { known: med(tk), unknown: med(tu), knownAll: tk, unknownAll: tu });
 // clearing: successful sign-in
 const c1 = 'clear1@example.com'; await signup(c1); await welcome(await mint(c1), pwA);
 for (let i = 0; i < 9; i++) await login(c1, 'bad' + i); const okIn = await login(c1, pwA); const again = []; for (let i = 0; i < 9; i++) again.push((await login(c1, 'bad2' + i)).status);
 info('9 fails, success, 9 fails', { success: okIn.status, after: again.join(',') });
 // clearing: reset
 for (let i = 0; i < 2; i++) await login(c1, 'bad3' + i);
 info('clear1 now', await login(c1, pwA + 'no'));
 { const lk = 'reset@example.com'; await signup(lk); await welcome(await mint(lk), pwA); for (let i = 0; i < 10; i++) await login(lk, 'bad' + i);
   info('reset@ locked', await login(lk, pwA));
   r = await req(null, '/api/auth/forgot', { method: 'POST', ...J({ email: lk }) }); info('forgot', r.status);
   const tokRow = rows("SELECT identifier FROM verifications WHERE identifier LIKE 'reset-password:%' ORDER BY rowid DESC LIMIT 1")[0];
   if (tokRow) { const rj = new Jar(); r = await req(rj, '/api/auth/reset', { method: 'POST', ...J({ token: tokRow.identifier.split(':')[1], password: 'New-pass-' + pwB }) }); info('reset while locked', { status: r.status, signedIn: rj.c.size > 0 }); info('sign-in after reset', await login(lk, 'New-pass-' + pwB)); }
   else info('reset token', 'not found in DB'); }
 // clearing: welcome
 { const w = 'welc@example.com'; await signup(w); for (let i = 0; i < 10; i++) await login(w, 'bad' + i); info('unconfirmed welc@ locked', (await login(w, 'whatever-1')).status); r = await welcome(await mint(w), pwA); info('welcome while locked', r.status); info('sign-in after welcome', await login(w, pwA)); }
 info('signin-fail rows', rows("SELECT count(*) AS n FROM auth_rate_limits WHERE key LIKE 'signin-fail:%'")[0]);
 info('mcp/oauth unaffected', { register: (await req(null, '/oauth/register', { method: 'POST', origin: false, ...J({ client_name: 'p', redirect_uris: ['http://127.0.0.1:9999/cb'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).status, mcpAnon: (await req(null, '/mcp', { method: 'POST', ...J({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).status });
}
if (PHASE === 'closed') {
 info('closed: resend', await resend('victim2@example.com'));
 info('closed: signup', await signup('closed-x@example.com'));
 const st = await (await req(null, '/api/auth/status')).json(); info('closed: status', { signup_open: st.signup_open, signin_available: st.signin_available });
 const ok = 'thr2@example.com';
 const f = []; for (let i = 0; i < 11; i++) f.push((await login(ok, 'w' + i)).status); info('closed: 11 wrong for an unknown address', f.join(','));
 info('closed: existing user right password', await login('verified@example.com', pwA));
}
console.log('SUMMARY', JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length }));
