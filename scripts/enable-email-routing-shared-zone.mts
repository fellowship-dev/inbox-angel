#!/usr/bin/env npx tsx
// Enable Cloudflare Email Routing on a zone that already has MX records for
// another mail provider (e.g. Proton Mail, Google Workspace).
//
// Problem: CF Email Routing requires "enabling" on the zone, which overwrites
// the root domain's MX records with CF's own route{1,2,3}.mx.cloudflare.net.
// This breaks mail delivery for the root domain.
//
// Solution: this script enables Email Routing, then immediately restores the
// original root MX records — so the root domain keeps using the existing
// provider while the reports subdomain uses CF Email Routing → Worker.
//
// Usage:
//   CLOUDFLARE_API_TOKEN=<token> \
//   CLOUDFLARE_ZONE_ID=<zone-id> \
//   ROOT_DOMAIN=fellowship.dev \
//   REPORTS_DOMAIN=reports.fellowship.dev \
//   WORKER_NAME=ready-set-mail-worker \
//   npx tsx scripts/enable-email-routing-shared-zone.mts
//
// Token permissions (same as the worker's CLOUDFLARE_API_TOKEN):
//   Account: Account Settings:Read, Workers Scripts:Edit, D1:Edit, Email Sending:Edit
//   Zone (All zones): Zone:Read, Email Routing Rules:Edit, DNS:Edit, Workers Routes:Edit

const TOKEN  = process.env.CLOUDFLARE_API_TOKEN;
const ZONE   = process.env.CLOUDFLARE_ZONE_ID;
const ROOT   = process.env.ROOT_DOMAIN;
const DOMAIN = process.env.REPORTS_DOMAIN;
const WORKER = process.env.WORKER_NAME ?? 'ready-set-mail-worker';
// Override if CF already overwrote root MX. Format: "10:mail.protonmail.ch,20:mailsec.protonmail.ch"
const ORIGINAL_MX = process.env.ORIGINAL_MX;

if (!TOKEN || !ZONE || !ROOT || !DOMAIN) {
  console.error('Missing required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, ROOT_DOMAIN, REPORTS_DOMAIN');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/zones/${ZONE}`;
const headers = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

interface CfDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  priority?: number;
  ttl: number;
}

async function cf<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json() as { success: boolean; result: T; errors: { message: string; code: number }[] };
  if (!json.success) throw new Error(json.errors.map(e => `${e.message} [${e.code}]`).join(', '));
  return json.result;
}

// ── Step 1: Snapshot current root MX records ─────────────────

console.log(`1. Snapshotting current MX records for ${ROOT}…`);

interface OriginalMx {
  content: string;
  priority: number;
  ttl: number;
}

let rootMx: OriginalMx[];

if (ORIGINAL_MX) {
  // Parse override: "10:mail.protonmail.ch,20:mailsec.protonmail.ch"
  rootMx = ORIGINAL_MX.split(',').map(entry => {
    const [pri, host] = entry.split(':');
    return { content: host, priority: parseInt(pri, 10), ttl: 1 };
  });
  console.log(`   Using ORIGINAL_MX override:`);
} else {
  const allMx = await cf<CfDnsRecord[]>('GET', `/dns_records?type=MX&name=${ROOT}`);
  const liveMx = allMx.filter(r => r.name === ROOT && !r.content.includes('cloudflare.net'));
  if (liveMx.length > 0) {
    rootMx = liveMx;
    console.log(`   ✓ Found ${rootMx.length} non-CF MX record(s):`);
  } else {
    console.error(`   ✕ No non-Cloudflare MX records found for ${ROOT}.`);
    console.error(`     If CF already overwrote them, re-run with ORIGINAL_MX="10:mail.protonmail.ch,20:mailsec.protonmail.ch"`);
    process.exit(1);
  }
}

for (const r of rootMx) {
  console.log(`     ${r.priority} ${r.content}`);
}

// ── Step 2: Enable Email Routing ─────────────────────────────
// The PUT /email/routing/enable endpoint requires a permission that API tokens
// rarely have. If this fails, enable Email Routing manually from the Cloudflare
// dashboard (zone → Email → Email Routing → Enable), then re-run this script.
// The script will skip this step and proceed to restore your MX records.

console.log('\n2. Enabling Email Routing on zone…');
try {
  await cf('PUT', '/email/routing/enable');
  console.log('   ✓ Email Routing enabled');
  // Give CF a moment to create/update MX records
  console.log('   Waiting 3s for CF to propagate MX changes…');
  await new Promise(r => setTimeout(r, 3000));
} catch (e: any) {
  if (e.message.includes('already enabled') || e.message.includes('1064')) {
    console.log('   ✓ Email Routing already enabled');
  } else if (e.message.includes('Authentication error') || e.message.includes('10000')) {
    console.log('   ⚠ Token lacks Email Routing enable permission — skipping.');
    console.log('     Enable it manually from the CF dashboard, then re-run this script.');
    console.log('     Continuing with MX restoration…');
  } else {
    throw e;
  }
}

// ── Step 3: Delete CF's root MX records (they overwrote ours) ─

console.log(`\n3. Cleaning up CF Email Routing MX records on ${ROOT}…`);
const postMx = await cf<CfDnsRecord[]>('GET', `/dns_records?type=MX&name=${ROOT}`);
const cfMxRecords = postMx.filter(r =>
  r.name === ROOT && r.content.includes('mx.cloudflare.net')
);

if (cfMxRecords.length > 0) {
  for (const r of cfMxRecords) {
    console.log(`   Deleting CF MX: ${r.priority} ${r.content} (id: ${r.id})`);
    await cf('DELETE', `/dns_records/${r.id}`);
  }
  console.log(`   ✓ Removed ${cfMxRecords.length} CF MX record(s) from root`);
} else {
  console.log('   → No CF MX records found on root (original provider MX may still be intact)');
}

// ── Step 4: Restore original root MX records ─────────────────

console.log(`\n4. Restoring original MX records for ${ROOT}…`);
const currentMx = await cf<CfDnsRecord[]>('GET', `/dns_records?type=MX&name=${ROOT}`);
const currentContents = new Set(currentMx.filter(r => r.name === ROOT).map(r => r.content));

for (const orig of rootMx) {
  if (currentContents.has(orig.content)) {
    console.log(`   → ${orig.priority} ${orig.content} already exists, skipping`);
    continue;
  }
  await cf('POST', '/dns_records', {
    type: 'MX',
    name: ROOT,
    content: orig.content,
    priority: orig.priority,
    ttl: orig.ttl || 1,
  });
  console.log(`   ✓ Restored MX ${orig.priority} ${orig.content}`);
}

// ── Step 5: Ensure subdomain MX records exist ────────────────

console.log(`\n5. Ensuring MX records for ${DOMAIN}…`);
const subMx = await cf<CfDnsRecord[]>('GET', `/dns_records?type=MX&name=${DOMAIN}`);
const subExisting = subMx.filter(r => r.name === DOMAIN);

const CF_MX = [
  { priority: 40, content: 'route1.mx.cloudflare.net' },
  { priority: 83, content: 'route2.mx.cloudflare.net' },
  { priority: 98, content: 'route3.mx.cloudflare.net' },
];

const subContents = new Set(subExisting.map(r => r.content));
let subAdded = 0;

for (const mx of CF_MX) {
  if (subContents.has(mx.content)) continue;
  await cf('POST', '/dns_records', {
    type: 'MX',
    name: DOMAIN,
    content: mx.content,
    priority: mx.priority,
    ttl: 1,
  });
  subAdded++;
}

if (subAdded > 0) {
  console.log(`   ✓ Added ${subAdded} MX record(s) for ${DOMAIN}`);
} else {
  console.log(`   → All ${CF_MX.length} MX records already exist for ${DOMAIN}`);
}

// ── Step 6: Set catch-all rule → Worker ──────────────────────

console.log(`\n6. Setting catch-all rule → Worker "${WORKER}"…`);
await cf('PUT', '/email/routing/rules/catch_all', {
  actions: [{ type: 'worker', value: [WORKER] }],
  enabled: true,
  matchers: [{ type: 'all' }],
  name: `catch-all → ${WORKER}`,
});
console.log('   ✓ Catch-all rule set');

// ── Step 7: Verify ───────────────────────────────────────────

console.log('\n7. Verifying…');
const finalRoot = await cf<CfDnsRecord[]>('GET', `/dns_records?type=MX&name=${ROOT}`);
const finalSub  = await cf<CfDnsRecord[]>('GET', `/dns_records?type=MX&name=${DOMAIN}`);

const rootOk = finalRoot.filter(r => r.name === ROOT);
const subOk  = finalSub.filter(r => r.name === DOMAIN);

console.log(`   ${ROOT} MX:`);
for (const r of rootOk) console.log(`     ${r.priority} ${r.content}`);

console.log(`   ${DOMAIN} MX:`);
for (const r of subOk) console.log(`     ${r.priority} ${r.content}`);

const rootHasProvider = rootOk.some(r => !r.content.includes('cloudflare.net'));
const subHasCf = subOk.some(r => r.content.includes('cloudflare.net'));

if (rootHasProvider && subHasCf) {
  console.log(`
✓ Done. Email routing configured:
  ${ROOT}   → original mail provider (MX restored)
  ${DOMAIN} → Worker "${WORKER}" (via CF Email Routing)
`);
} else {
  console.warn(`
⚠ Verification issue:
  Root has provider MX: ${rootHasProvider}
  Subdomain has CF MX:  ${subHasCf}
  Check the records above and fix manually if needed.
`);
}
