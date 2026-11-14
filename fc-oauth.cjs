// Flow j: an agent finds the service, registers, the person consents in the browser, the agent gets a token and a first answer.
const { open } = require('./fc-h-lib.cjs'); const crypto = require('crypto');
(async () => {
  const vw = +process.env.VW; const { page, snap, done, sleep, H } = await open(vw, process.env.ACCT);
  const t0 = Date.now(); const log = (...a) => console.log('  ', ...a);
  const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t.slice(0, 300) }; } };
  // 1. discovery, as an agent with no credentials
  for (const p of ['/llms.txt', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']) { const r = await page.request.get(H + p); log('GET', p, r.status(), (await r.text()).slice(0, 260).replace(/\n/g, ' | ')); }
  const un = await page.request.post(H + '/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'walk', version: '0' } } }, headers: { accept: 'application/json, text/event-stream' } });
  log('POST /mcp without a token ->', un.status(), 'WWW-Authenticate:', (un.headers()['www-authenticate'] || '').slice(0, 200));
  // 2. dynamic client registration
  const redirect = 'http://127.0.0.1:9911/callback';
  const reg = await page.request.post(H + '/oauth/register', { data: { client_name: 'Walk agent', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
  const regj = await j(reg); log('POST /oauth/register ->', reg.status(), Object.keys(regj).join(','));
  const verifier = crypto.randomBytes(32).toString('base64url'); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: regj.client_id, redirect_uri: redirect, scope: 'inbox-angel', resource: H + '/mcp', code_challenge: challenge, code_challenge_method: 'S256', state: 'walk' });
  let code = null;
  await page.route('http://127.0.0.1:9911/**', r => { code = new URL(r.request().url()).searchParams.get('code'); return r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Agent callback received</h1>' }); });
  await page.goto(H + '/oauth/authorize?' + q, { waitUntil: 'domcontentloaded' }); await sleep(3000);
  await snap('j1-consent', 'consent screen as first shown');
  const boxes = page.getByRole('checkbox'); const n = await boxes.count(); log('checkboxes on consent:', n);
  for (let i = 0; i < n; i++) { const b = boxes.nth(i); log('  box', i, (await b.getAttribute('aria-label')) || (await b.evaluate(e => (e.closest('label') || e.parentElement).innerText.replace(/\s+/g, ' ').slice(0, 110))), 'checked=', await b.isChecked().catch(() => '?'), 'disabled=', await b.isDisabled().catch(() => '?')); }
  for (let i = 0; i < n; i++) { const b = boxes.nth(i); if (!(await b.isChecked().catch(() => true)) && !(await b.isDisabled().catch(() => true))) await b.check({ timeout: 3000 }).catch(() => {}); }
  await snap('j2-consent-all-ticked', 'every available permission ticked');
  const approve = page.getByRole('button', { name: /allow|approve|authorize|grant|connect/i }).first();
  log('approve button:', await approve.innerText().catch(() => 'NOT FOUND'));
  await approve.click().catch(e => log('approve click failed', String(e).slice(0, 120))); await sleep(4000);
  await snap('j3-after-approve', 'after approving'); log('authorization code received:', !!code);
  if (code) {
    const tok = await page.request.post(H + '/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: regj.client_id, code_verifier: verifier, resource: H + '/mcp' } });
    const tj = await j(tok); log('POST /oauth/token ->', tok.status(), Object.keys(tj).join(','), 'expires_in', tj.expires_in);
    const rpc = async (method, params, id) => { const r = await page.request.post(H + '/mcp', { headers: { authorization: 'Bearer ' + tj.access_token, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, data: { jsonrpc: '2.0', id, method, params } }); const t = await r.text(); const m = t.match(/\{[\s\S]*\}/); return { status: r.status(), body: m ? JSON.parse(m[0]) : t.slice(0, 300) }; };
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'walk', version: '0' } }, 1);
    log('initialize ->', init.status, JSON.stringify(init.body.result ? { server: init.body.result.serverInfo, instructions: (init.body.result.instructions || '').slice(0, 500) } : init.body).slice(0, 800));
    const tl = await rpc('tools/list', {}, 2); const tools = (tl.body.result && tl.body.result.tools) || [];
    log('tools/list ->', tl.status, tools.length, 'tools:', tools.map(t => t.name).join(', '));
    const first = tools.find(t => /list.*domain|domains/i.test(t.name)) || tools[0];
    if (first) { const c = await rpc('tools/call', { name: first.name, arguments: {} }, 3); log('first answer: tools/call', first.name, '->', c.status, JSON.stringify(c.body).slice(0, 900)); }
    log('seconds from discovery to first answer (scripted, includes waits):', Math.round((Date.now() - t0) / 1000));
  }
  await page.goto(H + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2500);
  const al = page.getByRole('link', { name: 'Agents' }).first(); if (await al.count()) { await al.click(); await sleep(3000); await snap('j4-agents-after-connect', 'Agents page after the agent connected'); }
  await done();
})().catch(e => { console.log('FATAL', String(e).slice(0, 800)); process.exit(1); });
