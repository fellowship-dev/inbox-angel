const { open } = require('./fc-h-lib.cjs'); const crypto = require('crypto');
(async () => {
  const { page, done, sleep, H } = await open(1440, 'agency');
  const reg = await (await page.request.post(H + '/oauth/register', { data: { client_name: 'Walk agent 2', redirect_uris: ['http://127.0.0.1:9911/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } })).json();
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9911/callback', scope: 'inbox-angel', resource: H + '/mcp', code_challenge: crypto.createHash('sha256').update('x'.repeat(50)).digest('base64url'), code_challenge_method: 'S256', state: 'w' });
  page.on('request', async r => { if (r.method() === 'POST' && r.url().includes('/oauth/authorize')) { const h = await r.allHeaders(); console.log('POST headers: origin=' + h.origin + ' | referer=' + h.referer + ' | sec-fetch-site=' + h['sec-fetch-site']); } });
  const resp = await page.goto(H + '/oauth/authorize?' + q, { waitUntil: 'domcontentloaded' }); console.log('consent page referrer-policy header:', resp.headers()['referrer-policy']); await sleep(2000);
  await page.getByRole('checkbox').nth(0).check(); await page.getByRole('checkbox', { name: /Read email health reports/ }).check();
  await page.getByRole('button', { name: 'Allow access' }).click(); await sleep(3000);
  console.log('result:', (await page.evaluate(() => document.body.innerText)).slice(0, 200), '| url', page.url().slice(0, 80));
  await done();
})().catch(e => { console.log('FATAL', String(e).slice(0, 400)); process.exit(1); });
