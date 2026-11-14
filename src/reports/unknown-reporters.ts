// For the INSTANCE OWNER only (the same check as the leads page: `isInstanceOwner`; 403 for anyone else). Two read-only views:
//
//   GET /api/instance/reporter-candidates?limit=…
//       Authenticated senders that are NOT in the registry, so the registry can grow by hand: DKIM organisation, From domain, the report's own
//       org_name and report email, reports, distinct workspaces, days seen, first/last seen. No report content, no customer, no address. A
//       candidate is never promoted automatically: the owner adds an entry with INTAKE_KNOWN_REPORTERS (docs/hosted.md).
//   GET /api/instance/intake-status
//       What inbound report mail carries (the last 3 days) and what that means: `intakeAuthStatus` (src/reports/auth-status.ts).

import type { BoundEnv } from '../index';
import { globalQueries } from '@ready-set-mail/db';
import { effectiveRegistry, parseOperatorEntries } from '../dmarc/known-reporters';
import { intakeAuthStatus } from './auth-status';
import { senderText } from '../hosted/intake-log';

const DAY = 86400;

export async function handleUnknownReporterRoutes(request: Request, env: BoundEnv, instanceOwner: boolean): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/instance/reporter-candidates' && url.pathname !== '/api/instance/intake-status') return null;
  if (request.method.toUpperCase() !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
  if (!instanceOwner) return Response.json({ error: 'instance owner only' }, { status: 403 });
  if (url.pathname === '/api/instance/intake-status') return Response.json(await intakeAuthStatus(env));
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  // Sender-written text is cleaned again on the way out (rows stored by an older build, or by anything else, are not trusted): no control characters, at most 64 characters.
  const candidates = (await globalQueries(env.DB).reporterCandidates.list(limit)).map((c) => ({ ...c, dkim_org: senderText(c.dkim_org), from_address: senderText(c.from_address), report_email: senderText(c.report_email), org_name: c.org_name === null ? null : senderText(c.org_name) }));
  return Response.json({
    candidates,
    registry: effectiveRegistry(env).map((e) => ({ id: e.id, label: e.label, dkim_orgs: e.dkimOrgs, from: e.from, report_emails: e.reportEmails, report_email_domains: e.reportEmailDomains ?? [], caveat: e.caveat ?? null })),
    issues: parseOperatorEntries(env.INTAKE_KNOWN_REPORTERS).issues,
    since: new Date(Date.now() - 90 * DAY * 1000).toISOString().slice(0, 10),
  });
}
