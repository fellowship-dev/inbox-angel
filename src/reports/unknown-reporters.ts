// For the INSTANCE OWNER only (the same check as the leads page: `isInstanceOwner`): the authenticated sending domains that are not on the
// known-reporters list, so the list can grow. Domain, how many reports, first and last seen. No report content, no customer, no address.
//
//   GET /api/instance/unknown-reporters?limit=…   →  { reporters: [{ reporter, reports, first_seen, last_seen }], known: [{ org, kind, value }] }
//
// `known` is the list in force (built-in entries, minus INTAKE_KNOWN_REPORTERS_REMOVE, plus INTAKE_KNOWN_REPORTERS), with `issues`
// naming any operator entry that was ignored. An operator adds a reporter by setting INTAKE_KNOWN_REPORTERS (no code change).

import type { BoundEnv } from '../index';
import { globalQueries } from '@inbox-angel/db';
import { effectiveKnownReporters, parseKnownReporterList } from '../dmarc/known-reporters';

export async function handleUnknownReporterRoutes(request: Request, env: BoundEnv, instanceOwner: boolean): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/instance/unknown-reporters') return null;
  if (request.method.toUpperCase() !== 'GET') return Response.json({ error: 'method not allowed' }, { status: 405 });
  if (!instanceOwner) return Response.json({ error: 'instance owner only' }, { status: 403 });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
  const reporters = await globalQueries(env.DB).unknownReporters.list(limit);
  return Response.json({
    reporters,
    known: effectiveKnownReporters(env),
    issues: parseKnownReporterList(env.INTAKE_KNOWN_REPORTERS).issues,
  });
}
