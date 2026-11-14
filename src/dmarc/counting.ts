// Which stored reports feed the numbers: REPORT_COUNTING=proven|all (packages/db/src/queries/counting.ts).
//
//   proven  only reports whose email proved the reporting organisation (needs AUTHSERV_ID + AUTHSERV_HEADER). The hosted default:
//           the report address is public, so anyone can mail a forged "100% pass" report to it.
//   all     every stored report. The self-host default: one tenant, a private address; and with AUTHSERV_* unset nothing is proven,
//           so `proven` would show zero counted reports on every existing install.
// A value that is not one of the two falls back to the default for the mode.

import type { CountingMode } from '@inbox-angel/db';
import { getMode } from '../tenancy/mode';

export function reportCounting(env: { REPORT_COUNTING?: string; MODE?: string }): CountingMode {
  const v = env.REPORT_COUNTING?.trim().toLowerCase();
  if (v === 'all' || v === 'proven') return v;
  return getMode(env) === 'saas' ? 'proven' : 'all';
}
