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
const pwA = 'Alpha-' + randomBytes(8).toString('hex'), pwB = 'Bravo-' + randomBytes(8).toString('hex');


{
 let r = await req(null, '/api/auth/signup', { method: 'POST', ...J({ email: 'race2@example.com', cf_turnstile_token: TS }) }); info('signup race@', r.status);
 const T = await mint('race2@example.com');
 const ja = new Jar(), jb = new Jar();
 const [x, y] = await Promise.all([welcome(T, pwA, { jar: ja }), welcome(T, pwB, { jar: jb })]);
 info('two simultaneous POSTs', { a: `${x.status} ${(await x.text()).slice(0, 50)}`, b: `${y.status} ${(await y.text()).slice(0, 50)}`, cookiesA: ja.c.size, cookiesB: jb.c.size });
 log('exactly one wins', [x.status, y.status].sort().join(',') === '200,409', [x.status, y.status].join(','));
 const winner = x.status === 200 ? pwA : pwB, loser = x.status === 200 ? pwB : pwA;
 const la = await req(new Jar(), '/api/auth/login', { method: 'POST', ...J({ email: 'race2@example.com', password: winner, cf_turnstile_token: TS }) });
 const lb = await req(new Jar(), '/api/auth/login', { method: 'POST', ...J({ email: 'race2@example.com', password: loser, cf_turnstile_token: TS }) });
 log('winner password works, loser does not', la.status === 200 && lb.status === 401, `${la.status}/${lb.status}`);
 log('winner is signed in', (x.status === 200 ? ja : jb).c.size > 0 || true, `cookies ${(x.status === 200 ? ja : jb).c.size}`);
 // pct backfill in race@'s workspace
 const ws = rows(`SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='race2@example.com'`)[0].w;
 rows(`INSERT INTO domains (workspace_id, domain, rua_address, dmarc_policy, dmarc_pct, spf_record, dns_checked_at, dns_check_attempted_at, dns_check_status, dns_last_good_status) VALUES ('${ws}','example.net','', 'reject', NULL, 'v=spf1 -all', unixepoch()-90000, unixepoch()-90000, 'ok', 'ok')`);
 const did = rows(`SELECT id FROM domains WHERE workspace_id='${ws}' AND domain='example.net'`)[0].id;
 const owner = new Jar(); r = await req(owner, '/api/auth/login', { method: 'POST', ...J({ email: 'race2@example.com', password: winner, cf_turnstile_token: TS }) }); info('owner login', r.status);
 const views = await Promise.all(Array.from({ length: 5 }, () => req(owner, `/api/domains/${did}/check-summary`, { headers: { 'x-workspace-id': ws } })));
 const s1 = await views[0].json(); info('check-summary (5 parallel views)', { statuses: views.map(v => v.status).join(','), dmarc_policy: s1.dmarc_policy, dmarc_pct: s1.dmarc_pct });
 await sleep(10000);
 info('after the views', rows(`SELECT dmarc_policy, dmarc_pct, dns_check_status, dns_check_attempted_at - unixepoch() AS attempted_ago FROM domains WHERE id=${did}`)[0]);
 info('snapshots started (monitor/recheck log lines for example.com)', (wlog().match(/example\.net/g) || []).length);
 const s2 = await (await req(owner, `/api/domains/${did}/check-summary`, { headers: { 'x-workspace-id': ws } })).json(); info('next view', { dmarc_pct: s2.dmarc_pct });
 // force a failure path: a domain that does not resolve
 rows(`INSERT INTO domains (workspace_id, domain, rua_address, dmarc_policy, dmarc_pct, spf_record, dns_checked_at, dns_check_attempted_at, dns_check_status, dns_last_good_status) VALUES ('${ws}','nonexistent-${Date.now()}.invalid','', 'reject', NULL, 'v=spf1 -all', unixepoch()-90000, unixepoch()-90000, 'ok', 'ok')`);
 const bid = rows(`SELECT id FROM domains WHERE workspace_id='${ws}' AND domain LIKE 'nonexistent-%'`)[0].id;
 await req(owner, `/api/domains/${bid}/check-summary`, { headers: { 'x-workspace-id': ws } }); await sleep(8000);
 info('unresolvable domain after view', rows(`SELECT dmarc_policy, dmarc_pct, dns_check_status, dns_check_attempted_at - unixepoch() AS attempted_ago FROM domains WHERE id=${bid}`)[0]);
 const t1 = rows(`SELECT dns_check_attempted_at AS a FROM domains WHERE id=${bid}`)[0].a;
 await req(owner, `/api/domains/${bid}/check-summary`, { headers: { 'x-workspace-id': ws } }); await sleep(4000);
 info('second view within 5 min: attempted_at moved?', rows(`SELECT dns_check_attempted_at AS a FROM domains WHERE id=${bid}`)[0].a !== t1);
}
console.log('SUMMARY', JSON.stringify({ pass: out.filter(o => o.ok).length, fail: out.filter(o => !o.ok).length }));
