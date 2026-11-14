// Finish flow j with the Origin header a browser would send if the consent page did not blank it: shows what happens after the fix.
const { open } = require('./fc-h-lib.cjs'); const crypto = require('crypto');
(async () => {
  const { page, snap, done, sleep, H } = await open(1440, 'agency'); const log = (...a) => console.log('  ', ...a);
  const redirect = 'http://127.0.0.1:9911/callback';
  const reg = await (await page.request.post(H + '/oauth/register', { data: { client_name: 'Walk agent 3', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, scope: 'inbox-angel', resource: H + '/mcp', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'w' });
  await page.goto(H + '/oauth/authorize?' + q, { waitUntil: 'domcontentloaded' }); await sleep(2000);
  await page.getByRole('checkbox').nth(0).check();
  for (const n of [/See the domains you select/, /Read email health reports/, /Run live DNS checks/]) await page.getByRole('checkbox', { name: n }).check();
  const form = await page.evaluate(() => { const f = document.querySelector('form'); return { action: f.action, pairs: [...new FormData(f).entries()].map(([k, v]) => [k, String(v)]) }; });
  const allow = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(b => /Allow access/.test(b.innerText)); return b && b.name ? [b.name, b.value] : null; });
  if (allow) form.pairs.push(allow);
  log('form fields:', [...new Set(form.pairs.map(p => p[0]))].join(','));
  const body = form.pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const r = await page.request.post(form.action, { headers: { origin: H, 'content-type': 'application/x-www-form-urlencoded' }, data: body, maxRedirects: 0 });
  const loc = r.headers()['location'] || ''; log('POST /oauth/authorize with Origin ->', r.status(), loc.replace(/code=[^&]+/, 'code=***').slice(0, 120));
  const code = loc ? new URL(loc).searchParams.get('code') : null;
  if (code) {
    const tok = await page.request.post(H + '/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: H + '/mcp' } });
    const tj = await tok.json().catch(() => ({})); log('POST /oauth/token ->', tok.status(), Object.keys(tj).join(','), 'expires_in', tj.expires_in);
    const rpc = async (method, params, id) => { const r = await page.request.post(H + '/mcp', { headers: { authorization: 'Bearer ' + tj.access_token, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, data: { jsonrpc: '2.0', id, method, params } }); const t = await r.text(); const m = t.match(/\{[\s\S]*\}/); let b; try { b = m ? JSON.parse(m[0]) : t.slice(0, 300); } catch { b = t.slice(0, 300); } return { status: r.status(), body: b }; };
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'walk', version: '0' } }, 1);
    log('initialize ->', init.status, JSON.stringify(init.body.result ? { server: init.body.result.serverInfo, instructions: (init.body.result.instructions || '').slice(0, 600) } : init.body).slice(0, 900));
    const tl = await rpc('tools/list', {}, 2); const tools = (tl.body.result && tl.body.result.tools) || [];
    log('tools/list ->', tl.status, tools.length, 'tools:', tools.map(t => t.name).join(', '));
    for (const name of ['whoami', 'list_domains']) if (tools.find(t => t.name === name)) { const c = await rpc('tools/call', { name, arguments: {} }, 3); log('tools/call', name, '->', c.status, JSON.stringify(c.body).slice(0, 700)); }
  }
  await page.goto(H + '/#/', { waitUntil: 'domcontentloaded' }); await sleep(2500);
  await page.getByRole('link', { name: 'Agents' }).first().click().catch(() => {}); await sleep(3000); await snap('j4-agents-after-connect', 'Agents page after a connection exists');
  await page.getByRole('link', { name: 'Settings' }).first().click().catch(() => {}); await sleep(3000); await snap('j5-settings-connections', 'Settings: authorized agents');
  await done();
})().catch(e => { console.log('FATAL', String(e).slice(0, 600)); process.exit(1); });
