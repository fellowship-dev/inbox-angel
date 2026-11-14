// Can any report be counted right now? A pure decision over what inbound report mail carried (counters, no address), plus the loader.
// Exposed so the setup check (src/setup/preflight.ts) can call `describeAuthStatus` later without reading D1 itself.

import { globalQueries } from '@ready-set-mail/db';

export type AuthStatusKind = 'ok' | 'no_traffic' | 'unconfigured' | 'no_results' | 'foreign_authserv' | 'unauthenticated_only';

export interface AuthObservations {
  /** AUTHSERV_ID and AUTHSERV_HEADER are both set. */
  configured: boolean;
  /** Messages in the window by what they carried. */
  ok: number;
  present: number;
  absent: number;
  foreign: number;
}

export interface AuthStatus { kind: AuthStatusKind; text: string | null; observations: AuthObservations }

export const AUTH_TEXT = {
  unconfigured: 'No report can be counted until AUTHSERV_ID and AUTHSERV_HEADER are set.',
  no_results: 'No report can be counted: inbound mail carries no authentication results.',
  foreign_authserv: 'No report can be counted: the authentication results on inbound mail do not name the configured AUTHSERV_ID.',
  unauthenticated_only: 'No report can be counted: no inbound message has authenticated yet.',
} as const;

/** Pure: what the observations mean. `text` is the sentence for the instance owner, or null when all is well (or nothing has arrived yet). */
export function describeAuthStatus(o: AuthObservations): AuthStatus {
  const mk = (kind: AuthStatusKind, text: string | null): AuthStatus => ({ kind, text, observations: o });
  if (!o.configured) return mk('unconfigured', AUTH_TEXT.unconfigured);
  const total = o.ok + o.present + o.absent + o.foreign;
  if (!total) return mk('no_traffic', null);
  if (o.ok > 0) return mk('ok', null);
  if (o.absent > 0 && o.present === 0 && o.foreign === 0) return mk('no_results', AUTH_TEXT.no_results);
  if (o.foreign > 0 && o.present === 0) return mk('foreign_authserv', AUTH_TEXT.foreign_authserv);
  return mk('unauthenticated_only', AUTH_TEXT.unauthenticated_only);
}

/** Load the last 3 days of observations and describe them. */
export async function intakeAuthStatus(env: { DB: D1Database; AUTHSERV_ID?: string; AUTHSERV_HEADER?: string }, nowSeconds = Math.floor(Date.now() / 1000)): Promise<AuthStatus> {
  const since = new Date((nowSeconds - 3 * 86400) * 1000).toISOString().slice(0, 10);
  const rows = await globalQueries(env.DB).authObservations.since(since);
  const n = (k: string) => Number(rows.find((r) => r.scope === 'auth:' + k)?.messages ?? 0);
  const configured = !!env.AUTHSERV_ID?.trim() && ['ar', 'arc'].includes(env.AUTHSERV_HEADER?.trim().toLowerCase() ?? '');
  return describeAuthStatus({ configured, ok: n('ok'), present: n('present'), absent: n('absent'), foreign: n('foreign') });
}
