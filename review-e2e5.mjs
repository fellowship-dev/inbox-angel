// PR 154 review: hosted sign-up, verification/welcome token, enumeration, closed sign-up, consent header matrix.
// Phases: open | closed. Never prints secrets, tokens or cookies (only their shapes and lengths).
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
const sql = (s) => execSync(`npx wrangler d1 execute DB --local --json --command ${JSON.stringify(s)}`, { cwd: '/workspace/ready-set-mail', stdio: 'pipe' }).toString();
const rows = (s) => JSON.parse(sql(s))[0].results;
class Jar { constructor() { this.c = new Map(); } header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
 take(res) { for (const sc of res.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/max-age=0/i.test(sc) || v === '') this.c.delete(k); else this.c.set(k, v); } } }
let ipn = 1; const freshIp = () => `198.51.100.${ipn++}`;
async function req(jar, path, { method = 'GET', headers = {}, body, origin = true, ip } = {}) {
 const h = { ...headers }; if (jar && jar.c.size) h.cookie = jar.header(); if (origin && method !== 'GET') h.origin ??= O; if (ip) h['cf-connecting-ip'] = ip;
 let res; for (let i = 0; ; i++) { try { res = await fetch(path.startsWith('http') ? path : O + path, { method, headers: h, body, redirect: 'manual' }); break; } catch (e) { if (i >= 3) throw e; await sleep(500); } }
 jar?.take(res); return res;
}
const jsonBody = (o) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
const TS = 'XXXX.DUMMY.TOKEN.XXXX';
async function mint(email) {
 const secret = readFileSync('/workspace/ready-set-mail/.dev.vars', 'utf8').match(/BETTER_AUTH_SECRET=(.*)/)[1];
 try { const { createEmailVerificationToken } = await import(require.resolve('better-auth/api')); return await createEmailVerificationToken(secret, email, undefined, 86400); }
 catch (e) { const { SignJWT } = await import(require.resolve('jose')); return await new SignJWT({ email }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('24h').sign(new TextEncoder().encode(secret)); }
}

if (PHASE === 'open') {
 let r = await req(null, '/api/auth/status'); const st = await r.json(); info('status', { signup_open: st.signup_open, signin_available: st.signin_available, oauth: st.oauth_providers });
 // sign-up, email only
 const t0 = Date.now(); r = await req(null, '/api/auth/signup', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'new@example.com', cf_turnstile_token: TS }) });
 const b1 = await r.text(); info('signup new (email only)', { status: r.status, ms: Date.now() - t0, body: b1.slice(0, 200), setCookie: (r.headers.getSetCookie() || []).map(s => s.split('=')[0]) });
 const u = rows("SELECT u.id, u.email_verified, (SELECT count(*) FROM auth_accounts a WHERE a.user_id=u.id AND a.password IS NOT NULL) AS pw, (SELECT length(a.password) FROM auth_accounts a WHERE a.user_id=u.id) AS pwlen, (SELECT count(*) FROM sessions s WHERE s.user_id=u.id) AS sessions, (SELECT count(*) FROM memberships m WHERE m.user_id=u.id) AS memberships FROM users u WHERE email='new@example.com'")[0];
 info('new user row', { verified: u.email_verified, hasPassword: u.pw, hashLen: u.pwlen, sessions: u.sessions, memberships: u.memberships });
 // repeat with the same email: enumeration
 const t1 = Date.now(); r = await req(null, '/api/auth/signup', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'new@example.com', cf_turnstile_token: TS }) });
 info('signup same email again (unverified)', { status: r.status, ms: Date.now() - t1, body: (await r.text()).slice(0, 200) });
 // API client still sending a password
 r = await req(null, '/api/auth/signup', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'withpw@example.com', password: 'attacker-chosen-1', cf_turnstile_token: TS }) });
 info('signup with password (API client)', { status: r.status, body: (await r.text()).slice(0, 120) });
 r = await req(null, '/api/auth/signup', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'short@example.com', password: 'short', cf_turnstile_token: TS }) });
 info('signup with short password', r.status);
 r = await req(null, '/api/auth/signup', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'nobot@example.com' }) });
 info('signup without bot token', `${r.status} ${(await r.text()).slice(0, 80)}`);
 // the pre-verification password: can it sign in, does it mail?
 const atk = new Jar(); r = await req(atk, '/api/auth/login', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'withpw@example.com', password: 'attacker-chosen-1', cf_turnstile_token: TS }) });
 info('login with pre-verification password', { status: r.status, body: (await r.text()).slice(0, 120), cookies: atk.c.size });
 r = await req(atk, '/api/me', {}); info('/api/me after that login', r.status);
 r = await req(null, '/api/auth/login', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'new@example.com', password: 'guess-guess-1', cf_turnstile_token: TS }) });
 info('login unverified wrong password', `${r.status} ${(await r.text()).slice(0, 80)}`);
 // resend: same answer for unknown / unverified; per-IP limit
 for (const e of ['new@example.com', 'nobody@example.com']) { r = await req(null, '/api/auth/resend-verification', { method: 'POST', ip: freshIp(), ...jsonBody({ email: e }) }); info(`resend ${e}`, `${r.status} ${(await r.text()).slice(0, 60)}`); }
 const one = freshIp(); const rs = []; for (let i = 0; i < 12; i++) rs.push((await req(null, '/api/auth/resend-verification', { method: 'POST', ip: one, ...jsonBody({ email: 'new@example.com' }) })).status);
 info('resend x12 from one IP', rs.join(','));
 const many = []; for (let i = 0; i < 12; i++) many.push((await req(null, '/api/auth/resend-verification', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'new@example.com' }) })).status);
 info('resend x12 from 12 IPs (per-address cap?)', many.join(','));
 const vrows = rows("SELECT count(*) AS n FROM verifications"); info('verification rows (Better Auth JWT links are stateless)', vrows);

 // verification link: mail scanner first, then the person, then a second browser
 const link = `/api/auth/verify-email?token=${await mint('new@example.com')}&callbackURL=%2F`;
 const scanner = await req(null, link, { ip: freshIp() }); const sLoc = scanner.headers.get('location') || '';
 info('1st GET (mail scanner, no cookies)', { status: scanner.status, location: sLoc.replace(/[0-9a-f]{48}/, '<48 hex>'), referrerPolicy: scanner.headers.get('referrer-policy'), setCookie: (scanner.headers.getSetCookie() || []).map(s => s.split('=')[0]) });
 const welcomeToken = (sLoc.match(/#\/welcome\/([0-9a-f]+)/) || [])[1];
 const after1 = rows("SELECT u.email_verified, (SELECT count(*) FROM auth_accounts a WHERE a.user_id=u.id AND a.password IS NOT NULL) AS pw FROM users u WHERE email='new@example.com'")[0]; info('after scanner GET', after1);
 const human = new Jar(); const h2 = await req(human, link, { ip: freshIp() });
 info('2nd GET (the person, same link)', { status: h2.status, location: (h2.headers.get('location') || '').replace(/[0-9a-f]{48}/, '<48 hex>'), cookies: human.c.size, body: h2.status >= 400 ? (await h2.text()).slice(0, 120) : '' });
 const link2 = `/api/auth/verify-email?token=${await mint('new@example.com')}&callbackURL=%2F`;
 const h3 = await req(new Jar(), link2, { ip: freshIp() }); info('GET of a freshly minted link (resend) after verification', { status: h3.status, location: (h3.headers.get('location') || '').replace(/[0-9a-f]{48}/, '<48 hex>') });
 // welcome token
 info('welcome token shape', { hexLen: welcomeToken?.length });
 const wrow = rows("SELECT identifier, (expires_at - CAST(strftime('%s','now') AS INTEGER)) AS s_left, expires_at AS raw FROM verifications WHERE identifier LIKE 'reset-password:%'");
 info('welcome token stored', wrow.map(w => ({ s_left: w.s_left, raw: w.raw })));
 r = await req(null, '/api/auth/reset', { method: 'POST', ip: freshIp(), ...jsonBody({ token: welcomeToken, password: 'short' }) }); info('set password: too short', r.status);
 r = await req(null, '/api/auth/reset', { method: 'POST', ip: freshIp(), ...jsonBody({ token: 'f'.repeat(48), password: sec.password }) }); info('set password: wrong token', `${r.status} ${(await r.text()).slice(0, 60)}`);
 r = await req(null, '/api/auth/reset', { method: 'POST', ip: freshIp(), headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ token: 'e'.repeat(48), password: sec.password }) }); info('set password: cross-site Origin, wrong token', r.status);
 const person = new Jar(); r = await req(person, '/api/auth/reset', { method: 'POST', ip: freshIp(), ...jsonBody({ token: welcomeToken, password: sec.password }) });
 info('set password with welcome token', { status: r.status, signedIn: person.c.size > 0 || /token/.test(await r.clone().text()) });
 r = await req(person, '/api/me'); info('/api/me after welcome', r.status);
 r = await req(null, '/api/auth/reset', { method: 'POST', ip: freshIp(), ...jsonBody({ token: welcomeToken, password: 'another-pass-1' }) }); log('welcome token single use', r.status === 400, String(r.status));
 const h4 = await req(new Jar(), link, { ip: freshIp() }); info('original link again after password set', { status: h4.status, location: (h4.headers.get('location') || '').replace(/[0-9a-f]{48}/, '<48 hex>') });
 r = await req(new Jar(), '/api/auth/login', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'new@example.com', password: sec.password, cf_turnstile_token: TS }) }); log('chosen password still works after re-click', r.status === 200, String(r.status));
 // verified user signing up again: enumeration
 const t2 = Date.now(); r = await req(null, '/api/auth/signup', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'new@example.com', cf_turnstile_token: TS }) });
 info('signup with a verified address', { status: r.status, ms: Date.now() - t2, body: (await r.text()).slice(0, 200) });
 // pre-verification attacker account withpw@: verify it, check sessions dropped
 const before = rows("SELECT (SELECT count(*) FROM sessions s WHERE s.user_id=u.id) AS sessions FROM users u WHERE email='withpw@example.com'")[0];
 const v2 = await req(null, `/api/auth/verify-email?token=${await mint('withpw@example.com')}&callbackURL=%2F`, { ip: freshIp() });
 const after = rows("SELECT u.email_verified, (SELECT count(*) FROM sessions s WHERE s.user_id=u.id) AS sessions, (SELECT count(*) FROM auth_accounts a WHERE a.user_id=u.id AND a.password IS NOT NULL) AS pw FROM users u WHERE email='withpw@example.com'")[0];
 info('attacker-registered address verified by its owner', { status: v2.status, welcome: /welcome/.test(v2.headers.get('location') || ''), sessionsBefore: before.sessions, after });
 r = await req(new Jar(), '/api/auth/login', { method: 'POST', ip: freshIp(), ...jsonBody({ email: 'withpw@example.com', password: 'attacker-chosen-1', cf_turnstile_token: TS }) }); log('attacker password dead after verification', r.status === 401, String(r.status));
 // an invite for the closed phase, from the verified person
 r = await req(person, '/api/team/invite', { method: 'POST', ...jsonBody({ email: 'invitee@example.com', role: 'member' }) }); const inv = await r.json().catch(() => ({}));
 writeFileSync(H + '/ia-invite.json', JSON.stringify({ token: inv.token }), { mode: 0o600 }); info('invite created', r.status);
 // invitee in hosted (open): name only
 r = await req(null, `/api/invites/${inv.token}`, { method: 'POST', ip: freshIp(), ...jsonBody({ name: 'Invitee' }) }); info('hosted invite accept, name only (open)', `${r.status} ${(await r.text()).slice(0, 120)}`);
 r = await req(person, '/api/team/invite', { method: 'POST', ...jsonBody({ email: 'invitee2@example.com', role: 'member' }) }); const inv2 = await r.json().catch(() => ({}));
 writeFileSync(H + '/ia-invite.json', JSON.stringify({ token: inv2.token }), { mode: 0o600 });
}

if (PHASE === 'closed') {
 let r = await req(null, '/api/auth/status'); const st = await r.json(); info('status (closed)', { signup_open: st.signup_open, signin_available: st.signin_available, reason: st.signup_unavailable_reason, oauth: st.oauth_providers });
 const tries = [
  ['email sign-up', '/api/auth/signup', { email: 'closed1@example.com', cf_turnstile_token: TS }],
  ['email sign-up with password', '/api/auth/signup', { email: 'closed2@example.com', password: 'longenough-1', cf_turnstile_token: TS }],
  ['first-owner setup in hosted', '/api/auth/setup', { email: 'closed3@example.com', password: 'longenough-1' }],
  ['social sign-in start', '/api/auth/sign-in/social', { provider: 'github', callbackURL: '/' }],
  ['Better Auth sign-up passthrough', '/api/auth/sign-up/email', { email: 'closed4@example.com', password: 'longenough-1', name: 'x' }],
  ['existing user sign-in', '/api/auth/login', { email: 'new@example.com', password: sec.password }],
  ['forgot password', '/api/auth/forgot', { email: 'new@example.com' }],
  ['resend verification', '/api/auth/resend-verification', { email: 'withpw2@example.com' }],
 ];
 const inv = JSON.parse(readFileSync(H + '/ia-invite.json', 'utf8'));
 tries.push(['hosted invite acceptance', `/api/invites/${inv.token}`, { name: 'Invitee 2' }]);
 for (const [name, path, body] of tries) { r = await req(null, path, { method: 'POST', ip: freshIp(), ...jsonBody(body) }); info(`closed: ${name}`, `${r.status} ${(await r.text()).slice(0, 110)}`); }
 for (const p of ['/api/auth/callback/github?code=x&state=y', '/api/auth/callback/google?code=x&state=y']) { r = await req(null, p, { ip: freshIp() }); info(`closed: GET ${p.split('?')[0]}`, `${r.status} ${(r.headers.get('location') || '').slice(0, 80)}`); }
 const made = rows("SELECT email FROM users WHERE email LIKE 'closed%' OR email LIKE 'invitee2%'"); log('closed: no account created', made.length === 0, JSON.stringify(made));
}
console.log('SUMMARY', JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length, failed: out.filter(o => !o.ok).map(o => o.name) }));
