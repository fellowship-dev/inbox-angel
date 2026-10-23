// HTTP routes of the email funnel.
//
// Public (no login; the signed token is the credential):
//   GET|POST /api/unsubscribe?t=<token>     unsubscribe the address (GET: the link in the email body; POST: RFC 8058 one-click)
//   GET|POST /api/monitor/confirm?t=<token> confirm a change-alert subscription (double opt-in; GET shows a button, POST confirms)
// Instance owner only:
//   GET  /api/leads                         leads, counts, and whether the sequence can send
//   POST /api/leads/:id/stop                {reason: replied|booked|converted}

import { funnelQueries } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import { getMode } from '../tenancy/mode';
import { IMPLICIT_WORKSPACE_ID } from '@inbox-angel/db';
import { funnelMailer } from '../mail/mailer';
import { verifyToken } from '../mail/tokens';
import { bookingUrl, publicBaseUrl } from './config';
import { MANUAL_STOPS, stopLead, unsubscribeEmail, type ManualStop } from './enroll';
import { confirmMonitorSubscription } from './monitor-optin';
import { readiness } from './sequence';
import { SEQUENCE_DAYS } from './copy';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(title: string, message: string, status = 200, extraHtml = ''): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
      `<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#111827;"><h1 style="font-size:20px;">${esc(title)}</h1><p style="line-height:1.6;">${esc(message)}</p>${extraHtml}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}

/** Is the caller the person who runs this instance? OWNER_EMAIL if set; else (self-host only) the owner of the one workspace. */
export function isInstanceOwner(env: Pick<BoundEnv, 'MODE' | 'OWNER_EMAIL'>, who: { kind?: string; email?: string | null; role?: string; workspaceId: string }): boolean {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  if (owner) return !!who.email && who.email.toLowerCase() === owner;
  if (getMode(env) === 'saas') return false;
  return who.kind === 'instance' || (who.workspaceId === IMPLICIT_WORKSPACE_ID && who.role === 'owner');
}

export async function handlePublicFunnelRoute(request: Request, env: BoundEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.pathname === '/api/unsubscribe' && (method === 'GET' || method === 'POST')) {
    const p = await verifyToken(env, url.searchParams.get('t') ?? '');
    if (!p || p.p !== 'unsub') return method === 'POST' ? new Response('invalid token', { status: 400 }) : page('This link is not valid', 'The unsubscribe link is incomplete or has been altered. Reply to the email you received and we will remove you by hand.', 400);
    await unsubscribeEmail(env, p.e);
    return method === 'POST' ? new Response('unsubscribed', { status: 200 }) : page('You are unsubscribed', 'You will not get any more emails of this kind from Inbox Angel. Any follow-up series and change alerts for this address have been removed.');
  }

  if (url.pathname === '/api/monitor/confirm' && (method === 'GET' || method === 'POST')) {
    const token = url.searchParams.get('t') ?? '';
    const p = await verifyToken(env, token);
    if (!p || p.p !== 'confirm') return page('This link is not valid', 'The confirmation link is incomplete, altered or has expired. Request the alerts again from the email check page.', 400);
    // A GET only shows a button. Mail security scanners open links in emails; they must not be able to confirm for the owner.
    if (method === 'GET') {
      return page('Confirm email alerts', 'Press the button to start change alerts for your domain. If you did not ask for them, close this page and nothing will be sent.', 200, `<form method="post" action="/api/monitor/confirm?t=${encodeURIComponent(token)}"><button type="submit" style="padding:10px 18px;font-size:15px;cursor:pointer;">Confirm alerts</button></form>`);
    }
    const ok = await confirmMonitorSubscription(env, p);
    return ok ? page('Alerts confirmed', 'We will email you when the email security settings of your domain change. Every alert has an unsubscribe link.') : page('This request has expired', 'Unconfirmed requests are deleted after 7 days. Request the alerts again from the email check page.', 410);
  }
  return null;
}

export async function handleLeadRoutes(request: Request, env: BoundEnv, instanceOwner: boolean): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const stop = url.pathname.match(/^\/api\/leads\/(\d+)\/stop$/);
  if (url.pathname !== '/api/leads' && !stop) return null;
  if (!instanceOwner) return Response.json({ error: 'instance owner only' }, { status: 403 });
  const q = funnelQueries(env.DB);

  if (url.pathname === '/api/leads' && method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
    const [rows, counts] = await Promise.all([q.leads.list(limit, offset), q.leads.counts()]);
    const r = readiness(env);
    return Response.json({
      leads: rows.map((l) => ({
        id: l.id, email: l.email, domain: l.domain, source: l.source, level: l.check_level, step: l.step, steps_total: SEQUENCE_DAYS.length,
        status: l.status, next_send_at: l.next_send_at, last_sent_at: l.last_sent_at, created_at: l.created_at, last_activity_at: l.last_activity_at,
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      delivery: {
        enabled: r.enabled,
        can_send: r.enabled && r.blockers.length === 0,
        provider: funnelMailer(env)?.provider ?? null,
        blockers: r.blockers,
        warnings: r.warnings,
        booking_url_set: !!bookingUrl(env),
        public_base_url_set: !!publicBaseUrl(env),
      },
    });
  }

  if (stop && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    if (!MANUAL_STOPS.includes(body.reason as ManualStop)) return Response.json({ error: `reason must be one of ${MANUAL_STOPS.join(', ')}` }, { status: 400 });
    return (await stopLead(env, parseInt(stop[1], 10), body.reason as ManualStop)) ? Response.json({ ok: true }) : Response.json({ error: 'lead not found' }, { status: 404 });
  }
  return Response.json({ error: 'method not allowed' }, { status: 405 });
}
