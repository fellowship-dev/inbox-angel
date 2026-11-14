#!/usr/bin/env npx tsx
// One-time setup: configures Cloudflare Email Routing for REPORTS_DOMAIN.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=<zone-token> \
//   CLOUDFLARE_ZONE_ID=<zone-id> \
//   REPORTS_DOMAIN=reports.yourdomain.com \
//   WORKER_NAME=ready-set-mail-worker \
//   npx tsx scripts/setup-email-routing.ts
//
// What it does:
//   1. Enables Email Routing on the zone
//   2. Reads the MX records CF created for the zone apex
//   3. Adds the same MX records for REPORTS_DOMAIN (the subdomain)
//   4. Sets the catch-all rule: * → this Worker
//
// Token needs: Zone:Read + DNS:Edit + Email Routing:Edit (scoped to zone)

const TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const ZONE   = process.env.CLOUDFLARE_ZONE_ID;
const DOMAIN = process.env.REPORTS_DOMAIN;
const WORKER = process.env.WORKER_NAME ?? 'ready-set-mail-worker';

if (!TOKEN || !ZONE || !DOMAIN) {
  console.error('Missing required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, REPORTS_DOMAIN');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/zones/${ZONE}`;
const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function cf(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as { success: boolean; result: unknown; errors: { message: string }[] };
  if (!json.success) throw new Error(json.errors.map((e) => e.message).join(', '));
  return json.result;
}

// ── Step 1: Enable Email Routing ─────────────────────────────

console.log('1. Enabling Email Routing on zone…');
await cf('PUT', '/email/routing/enable');
console.log('   ✓ Email Routing enabled');

// ── Step 2: Read MX records CF created for the apex ──────────

console.log('2. Reading MX records for zone apex…');
const dnsRecords = await cf('GET', '/dns/records?type=MX') as { name: string; content: string; priority: number }[];
const apexMx = dnsRecords.filter((r) => !r.name.includes('.') || r.name === DOMAIN?.split('.').slice(-2).join('.'));

if (apexMx.length === 0) {
  console.warn('   ⚠ No MX records found for zone apex — Email Routing may still be initialising.');
  console.warn('     Wait a few seconds and re-run, or add MX records manually.');
  process.exit(1);
}

console.log(`   ✓ Found ${apexMx.length} MX record(s): ${apexMx.map((r) => r.content).join(', ')}`);

// ── Step 3: Add MX records for REPORTS_DOMAIN ────────────────

console.log(`3. Adding MX records for ${DOMAIN}…`);
const subdomain = DOMAIN!.split('.')[0]; // e.g. "reports"
const existing = await cf('GET', `/dns/records?type=MX&name=${DOMAIN}`) as { name: string }[];

for (const mx of apexMx) {
  const alreadyExists = existing.some((r) => r.name === DOMAIN);
  if (alreadyExists) {
    console.log(`   → MX for ${DOMAIN} already exists, skipping`);
    break;
  }
  await cf('POST', '/dns/records', {
    type: 'MX',
    name: subdomain,
    content: mx.content,
    priority: mx.priority,
    ttl: 1, // auto
  });
  console.log(`   ✓ Added MX ${mx.priority} ${mx.content}`);
}

// ── Step 4: Set catch-all rule → Worker ──────────────────────

console.log(`4. Setting catch-all rule → Worker "${WORKER}"…`);
await cf('PUT', '/email/routing/rules/catch_all', {
  actions: [{ type: 'worker', value: [WORKER] }],
  enabled: true,
  matchers: [{ type: 'all' }],
  name: `catch-all → ${WORKER}`,
});
console.log('   ✓ Catch-all rule set');

console.log(`
Done. Email routing configured:
  *@${DOMAIN} → Worker "${WORKER}"

Next: wrangler secret put CLOUDFLARE_API_TOKEN  (this same token, for runtime DNS provisioning)
      wrangler d1 migrations apply <db-name> --remote
      wrangler deploy
`);
