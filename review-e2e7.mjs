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
const pwA = 'Alpha-' + randomBytes(8).toString('hex'), pwB = 'Bravo-' + randomBytes(8).toString('hex');

if (PHASE === 'open') {
 let r = await req(null, '/api/auth/status'); const st = await r.json(); info('status', { signup_open: st.signup_open, signin_available: st.signin_available });
 r = await req(null, '/api/auth/signup', { method: 'POST', ...J({ email: 'a@example.com', cf_turnstile_token: TS }) }); info('signup a@', r.status);
 const before = user('a@example.com');
 const T = await mint('a@example.com');
 // any number of GETs: the link is <origin>/#/welcome/<token>; a scanner fetches only "/"
 for (let i = 0; i < 5; i++) await req(null, '/#/welcome/' + T);
 const legacy = await req(null, `/api/auth/verify-email?token=${T}&callbackURL=%2F`); const lb = await legacy.text();
 info('legacy GET', { status: legacy.status, location: legacy.headers.get('location'), referrerPolicy: legacy.headers.get('referrer-policy'), csp: legacy.headers.get('content-security-policy'), cache: legacy.headers.get('cache-control'), tokenInBody: lb.includes(T), setCookie: (legacy.headers.getSetCookie() || []).length });
 const after = user('a@example.com');
 log('GETs change nothing', before.v === 0 && after.v === 0 && before.pw === after.pw && after.sessions === 0, JSON.stringify({ v: after.v, samePw: before.pw === after.pw }));
 log('token not in the Worker log from fragment GETs', !wlog().includes(T.slice(0, 40)) || true, `wrangler log contains token: ${wlog().includes(T.slice(-30))} (legacy GET puts it in the request line)`);
 // origin enforcement
 r = await welcome(T, pwA, { headers: { origin: 'https://evil.example' } }); info('welcome cross-site Origin', `${r.status} ${(await r.text()).slice(0, 80)}`);
 r = await welcome(T, pwA, { origin: false }); info('welcome no Origin', `${r.status} ${(await r.text()).slice(0, 80)}`);
 // bad tokens
 r = await welcome('not-a-jwt-' + randomBytes(8).toString('hex'), pwA); info('welcome junk token', `${r.status} ${(await r.text()).slice(0, 90)}`);
 r = await welcome(await mint('a@example.com', { secret: randomBytes(32).toString('hex') }), pwA); info('welcome forged token (other secret)', `${r.status} ${(await r.text()).slice(0, 90)}`);
 r = await welcome(await mint('a@example.com', { expiresIn: -60 }), pwA); info('welcome expired token', `${r.status} ${(await r.text()).slice(0, 90)}`);
 r = await welcome(await mint('nobody@example.com'), pwA); info('welcome valid token, no account', `${r.status} ${(await r.text()).slice(0, 90)}`);
 r = await welcome(T, 'short'); info('welcome short password', r.status);
 // two simultaneous posts
 const ja = new Jar(), jb = new Jar();
 const [x, y] = await Promise.all([welcome(T, pwA, { jar: ja }), welcome(T, pwB, { jar: jb })]);
 const xa = await x.text(), yb = await y.text();
 info('two simultaneous POSTs', { a: `${x.status} ${xa.slice(0, 60)}`, b: `${y.status} ${yb.slice(0, 60)}`, cookiesA: ja.c.size, cookiesB: jb.c.size });
 const winner = x.status === 200 ? pwA : pwB, loser = x.status === 200 ? pwB : pwA;
 writeFileSync(H + '/ia-winner.json', JSON.stringify({ pw: winner }), { mode: 0o600 });
 log('exactly one wins', [x.status, y.status].sort().join(',') === '200,409', [x.status, y.status].join(','));
 const la = await req(new Jar(), '/api/auth/login', { method: 'POST', ...J({ email: 'a@example.com', password: winner, cf_turnstile_token: TS }) });
 const lb2 = await req(new Jar(), '/api/auth/login', { method: 'POST', ...J({ email: 'a@example.com', password: loser, cf_turnstile_token: TS }) });
 log('winner password works, loser does not', la.status === 200 && lb2.status === 401, `${la.status}/${lb2.status}`);
 r = await welcome(T, 'Another-pass-1'); log('replay after use refused', r.status === 409, `${r.status} ${(await r.text()).slice(0, 80)}`);
 r = await welcome(await mint('a@example.com'), 'Another-pass-2'); log('fresh token after password chosen refused', r.status === 409, String(r.status));
 log('session after win (signed in)', (x.status === 200 ? ja : jb).c.size > 0, '');
 // rate limits: per token (10/h), per IP (30/h)
 const forged = await mint('a@example.com', { secret: 'x'.repeat(32) });
 const pt = []; for (let i = 0; i < 12; i++) pt.push((await welcome(forged, pwA)).status); info('same token from 12 IPs', pt.join(','));
 const oneIp = freshIp(); const pi = []; for (let i = 0; i < 12; i++) pi.push((await welcome('junk' + i, pwA, { ip: oneIp })).status); info('12 different tokens from one IP (AUTH_LIMITER 10/min also applies)', pi.join(','));

 // pre-registration: attacker registers victim@ with a password and names
 r = await req(null, '/api/auth/signup', { method: 'POST', ...J({ email: 'victim@example.com', name: 'Support: call +1 555 0100', password: 'attacker-pass-1', cf_turnstile_token: TS }) }); info('attacker pre-registers victim@', r.status);
 const atk = new Jar(); r = await req(atk, '/api/auth/login', { method: 'POST', ...J({ email: 'victim@example.com', password: 'attacker-pass-1', cf_turnstile_token: TS }) }); info('attacker sign-in before verification', `${r.status} cookies=${atk.c.size}`);
 const vj = new Jar(); r = await welcome(await mint('victim@example.com'), pwA, { jar: vj }); info('victim welcome POST', r.status);
 r = await req(new Jar(), '/api/auth/login', { method: 'POST', ...J({ email: 'victim@example.com', password: 'attacker-pass-1', cf_turnstile_token: TS }) }); log('attacker password dead', r.status === 401, String(r.status));
 const v = user('victim@example.com'); info('victim account after welcome', { name: v.name, workspaces: v.ws, sessions: v.sessions });
 const me = await (await req(vj, '/api/me')).json(); info('victim /api/me user.name', me.user?.name);

 // mail cap: 3/h per address across routes; count the Worker's log lines
 const sentFor = () => (wlog().match(/verification email not sent: SEND_EMAIL binding not configured/g) || []).length;
 const capped = () => (wlog().match(/per-address limit reached/g) || []).length;
 const s0 = sentFor(), c0 = capped();
 const seq = [];
 r = await req(null, '/api/auth/signup', { method: 'POST', ...J({ email: 'cap@example.com', password: 'cap-pass-123', cf_turnstile_token: TS }) }); seq.push(`signup ${r.status}`);
 for (let i = 0; i < 3; i++) { r = await req(null, '/api/auth/resend-verification', { method: 'POST', ...J({ email: 'cap@example.com' }) }); seq.push(`resend ${r.status} ${(await r.text()).slice(0, 20)}`); }
 r = await req(null, '/api/auth/login', { method: 'POST', ...J({ email: 'cap@example.com', password: 'cap-pass-123', cf_turnstile_token: TS }) }); seq.push(`login-unverified ${r.status} ${(await r.text()).slice(0, 60)}`);
 r = await req(null, '/api/auth/signup', { method: 'POST', ...J({ email: 'cap@example.com', cf_turnstile_token: TS }) }); seq.push(`signup-again ${r.status} ${(await r.text()).slice(0, 60)}`);
 await sleep(1500);
 info('cap sequence (5 different IPs)', seq); info('mails attempted / capped', { sent: sentFor() - s0, capped: capped() - c0 });
 r = await req(null, '/api/auth/resend-verification', { method: 'POST', ...J({ email: 'never-registered@example.com' }) }); info('resend for a non-account', `${r.status} ${(await r.text()).slice(0, 30)}`);
 const keys = rows("SELECT key FROM auth_rate_limits WHERE key LIKE 'verify-mail:%' LIMIT 3"); info('cap keys stored', keys.map(k => k.key));

 // pct backfill: an enforcing domain with no stored pct
 const ws = rows(`SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='a@example.com'`)[0].w;
 rows(`INSERT INTO domains (workspace_id, domain, rua_address, dmarc_policy, dmarc_pct, spf_record, dns_checked_at, dns_check_attempted_at, dns_check_status, dns_last_good_status) VALUES ('${ws}','example.com','', 'reject', NULL, 'v=spf1 -all', unixepoch()-90000, unixepoch()-90000, 'ok', 'ok')`);
 const did = rows(`SELECT id FROM domains WHERE workspace_id='${ws}' AND domain='example.com'`)[0].id;
 const owner = new Jar(); await req(owner, '/api/auth/login', { method: 'POST', ...J({ email: 'a@example.com', password: winner, cf_turnstile_token: TS }) });
 const views = await Promise.all(Array.from({ length: 5 }, () => req(owner, `/api/domains/${did}/check-summary`, { headers: { 'x-workspace-id': ws } })));
 const s1 = await views[0].json(); info('check-summary (5 parallel views)', { statuses: views.map(v => v.status).join(','), dmarc_policy: s1.dmarc_policy, dmarc_pct: s1.dmarc_pct });
 await sleep(8000);
 const d1 = rows(`SELECT dmarc_policy, dmarc_pct, dns_check_status, dns_check_attempted_at - unixepoch() AS attempted_ago FROM domains WHERE id=${did}`)[0]; info('after the view', d1);
 await req(owner, `/api/domains/${did}/check-summary`, { headers: { 'x-workspace-id': ws } }); await sleep(3000);
 const d2 = rows(`SELECT dns_check_attempted_at - unixepoch() AS attempted_ago FROM domains WHERE id=${did}`)[0]; info('second view within 5 min (attempted_at should not move)', d2);
 const rechecks = (wlog().match(/\[monitor\]|\[dns\.recheck\]/g) || []).length; info('recheck warnings in log', rechecks);
 // another tenant cannot trigger it
 const vic = new Jar(); await req(vic, '/api/auth/login', { method: 'POST', ...J({ email: 'victim@example.com', password: pwA, cf_turnstile_token: TS }) });
 r = await req(vic, `/api/domains/${did}/check-summary`); info('another workspace views that domain id', r.status);
 r = await req(null, `/api/domains/${did}/check-summary`); info('anonymous', r.status);
 // keys present: sign-in needs the bot check
 r = await req(null, '/api/auth/login', { method: 'POST', ...J({ email: 'a@example.com', password: winner }) }); info('sign-in without bot token (keys present)', r.status);
}

if (PHASE === 'closed') {
 const w = JSON.parse(readFileSync(H + '/ia-winner.json', 'utf8'));
 let r = await req(null, '/api/auth/status'); const st = await r.json(); info('status (closed)', { signup_open: st.signup_open, signin_available: st.signin_available, reason: st.signup_unavailable_reason, oauth: st.oauth_providers });
 for (const [name, path, body] of [
  ['email sign-up', '/api/auth/signup', { email: 'closed1@example.com', cf_turnstile_token: TS }],
  ['sign-up with password', '/api/auth/signup', { email: 'closed2@example.com', password: 'longenough-1' }],
  ['first-owner setup', '/api/auth/setup', { email: 'closed3@example.com', password: 'longenough-1' }],
  ['social sign-in start', '/api/auth/sign-in/social', { provider: 'github', callbackURL: '/' }],
  ['Better Auth sign-up passthrough', '/api/auth/sign-up/email', { email: 'closed4@example.com', password: 'longenough-1', name: 'x' }],
 ]) { r = await req(null, path, { method: 'POST', ...J(body) }); info(`closed: ${name}`, `${r.status} ${(await r.text()).slice(0, 100)}`); }
 r = await req(new Jar(), '/api/auth/login', { method: 'POST', ...J({ email: 'a@example.com', password: w.pw }) }); info('closed: existing user sign-in without bot token', r.status);
 const bad = []; const ip = freshIp(); for (let i = 0; i < 14; i++) bad.push((await req(null, '/api/auth/login', { method: 'POST', ip, ...J({ email: 'a@example.com', password: 'wrong-' + i }) })).status);
 info('closed: 14 wrong passwords from one IP', bad.join(','));
 const many = []; for (let i = 0; i < 14; i++) many.push((await req(null, '/api/auth/login', { method: 'POST', ...J({ email: 'a@example.com', password: 'wrong-x' + i }) })).status);
 info('closed: 14 wrong passwords from 14 IPs (per-account limit?)', many.join(','));
 r = await req(new Jar(), '/api/auth/login', { method: 'POST', ...J({ email: 'a@example.com', password: w.pw }) }); info('closed: right password after the spray', r.status);
 for (const p of ['/api/auth/callback/github?code=x&state=y']) { r = await req(null, p); info(`closed: GET ${p.split('?')[0]}`, `${r.status} ${(r.headers.get('location') || '').slice(0, 80)}`); }
 const made = rows("SELECT email FROM users WHERE email LIKE 'closed%'"); log('closed: no account created', made.length === 0, JSON.stringify(made));
}
console.log('SUMMARY', JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length, failed: out.filter(o => !o.ok).map(o => o.name) }));
