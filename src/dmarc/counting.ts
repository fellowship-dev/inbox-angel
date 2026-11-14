// Which stored reports feed the numbers: REPORT_COUNTING=known|authenticated|all (packages/db/src/queries/counting.ts).
//
//   known          only reports that authenticated AND come from a known reporter (src/dmarc/known-reporters.ts). The hosted default, and
//                  the only mode that does not trust a stranger: a report address is public, and anyone can register a domain, sign mail
//                  with valid DKIM and send an authenticated fake report.
//   authenticated  every report whose email authenticated, known reporter or not. Weaker: an authenticated stranger counts.
//   all            every stored report, authenticated or not. The self-host default: an upgrade must not zero an existing dashboard, and
//                  with AUTHSERV_* unset (every existing install) nothing can be authenticated at all.
// Hosted can be set to a weaker mode only by naming it explicitly. A value that is not one of the three falls back to the mode's default.

import type { CountingMode } from '@inbox-angel/db';
import { getMode } from '../tenancy/mode';

export function reportCounting(env: { REPORT_COUNTING?: string; MODE?: string }): CountingMode {
  const v = env.REPORT_COUNTING?.trim().toLowerCase();
  if (v === 'known' || v === 'authenticated' || v === 'all') return v;
  return getMode(env) === 'saas' ? 'known' : 'all';
}
