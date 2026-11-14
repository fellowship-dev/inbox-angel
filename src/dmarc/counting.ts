// Which stored reports feed the numbers: REPORT_COUNTING=registry|authenticated|all (packages/db/src/queries/counting.ts).
//
//   registry       only reports whose carrier authenticated AND whose sender is in the reporter registry (src/dmarc/known-reporters.ts). The hosted
//                  default: a report address is public, so an authenticated stranger (any domain with DKIM) must not move the numbers.
//   authenticated  every report whose carrier authenticated, registry reporter or not. Weaker: an authenticated stranger counts.
//   all            every stored report. The self-host default: an upgrade must not zero an existing dashboard, and with AUTHSERV_* unset
//                  (every existing install) nothing can be authenticated at all.
// Hosted is weakened only by an explicit operator choice (REPORT_COUNTING=authenticated|all). A value that is not one of the three falls back to the default.

import type { CountingMode } from '@ready-set-mail/db';
import { getMode } from '../tenancy/mode';

export function reportCounting(env: { REPORT_COUNTING?: string; MODE?: string }): CountingMode {
  const v = env.REPORT_COUNTING?.trim().toLowerCase();
  if (v === 'registry' || v === 'authenticated' || v === 'all') return v;
  return getMode(env) === 'saas' ? 'registry' : 'all';
}
