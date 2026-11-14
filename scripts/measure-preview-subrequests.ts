// How many DNS-over-HTTPS subrequests does one claim preview cost? Counts the fetches `previewClaimDns` makes for each domain.
// Usage: npx tsx scripts/measure-preview-subrequests.ts google.com gov.uk
import { createResolver } from '@ready-set-mail/dns-checks';
import { previewClaimDns } from '../src/domains/claim-preview';

const domains = process.argv.slice(2);
if (domains.length === 0) {
  console.error('usage: measure-preview-subrequests.ts <domain>...');
  process.exit(2);
}

async function main() {
  for (const domain of domains) {
  let count = 0;
  const resolver = createResolver({ fetch: ((input: RequestInfo | URL, init?: RequestInit) => { count++; return fetch(input, init); }) as never });
  const view = await previewClaimDns(domain, { resolver, now: Date.now() });
  console.log(JSON.stringify({ domain, subrequests: count, spf: view.spf.status, spf_lookups: view.spf.lookup_count, dmarc: view.dmarc.status, dkim: view.dkim.status, dkim_scanned: view.dkim.scanned, dkim_found: view.dkim.selectors.length, mx: view.mx.status, failed: view.lookup_failed }));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
