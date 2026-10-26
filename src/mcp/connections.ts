import { consentPage, consentIdentity } from './consent';
import type { OAuthProviderOptions, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { accessLookups, authLookups, forWorkspace } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import { currentUser, passesCsrfCheck } from '../auth/session';
import { ACCESS_ACTIONS, validActions } from '../access/grant';
import { authorizeResource } from '../access/resolve';
import type { AccessSubject } from '../access/principal';
import { isSaas } from '../auth/config';
import { mcpInstallation } from './discovery';

const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const prefix = 'mcp_connection:';
export interface AgentConnection { principalId: string; userId: string; workspaceId: string; clientId: string; name: string; createdAt: number; expiresAt: number; lastUsedAt?: number }

/** Only the authenticated user's connection metadata; never grants or workspace contents. */
export async function listAgentConnections(env: BoundEnv, userId: string) {
 const connections: Array<AgentConnection & { revoked: boolean }> = [];
 for (const p of await accessLookups(env.DB).humanPrincipalsForUser(userId)) {
  const record = await forWorkspace(env.DB, p.workspace_id).settings.get(`${prefix}${p.id}`);
  if (record) connections.push({ ...JSON.parse(record.value), revoked: p.disabled_at !== null });
 }
 return connections;
}

export async function revokeAgentConnection(env: BoundEnv, userId: string, principalId: string, api: OAuthHelpers) {
 const p = await accessLookups(env.DB).principalById(principalId);
 if (!p || p.kind !== 'human' || p.user_id !== userId) return false;
 // D1 denial completes BEFORE eventually-consistent provider cleanup starts.
 await forWorkspace(env.DB, p.workspace_id).access.principals.disable(principalId, Math.floor(Date.now() / 1000));
 let cursor: string | undefined;
 do {
  const page = await api.listUserGrants(userId, { cursor });
  for (const grant of page.items) if (grant.metadata?.principalId === principalId) await api.revokeGrant(grant.id, userId);
  cursor = page.cursor;
 } while (cursor);
 return true;
}

export async function handleMcpConnections(request: Request, env: BoundEnv, ctx: ExecutionContext, options: OAuthProviderOptions<BoundEnv>): Promise<Response | null> {
 const url = new URL(request.url), path = url.pathname;
 if (path !== '/oauth/authorize' && !path.startsWith('/api/mcp/connections')) return null;
 const { getOAuthApi, AuthorizationError } = await import('@cloudflare/workers-oauth-provider');
 const api = getOAuthApi(options, env);
 const user = await currentUser(request, env, ctx);
 if (!user || (isSaas(env) && !user.emailVerified)) {
  if (request.method === 'GET' && path === '/oauth/authorize') return new Response(`<!doctype html><title>Sign in to Inbox Angel</title><p>Sign in to your Inbox Angel dashboard, then return to this authorization link.</p><a href="/">Open dashboard</a>`, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  return Response.json({ error: 'Sign in required' }, { status: 401 });
 }
 const memberships = await authLookups(env.DB).membershipsOf(user.id);
 const actor: AccessSubject = { principalId: user.id, kind: 'human', userId: user.id, workspaceId: memberships[0]?.workspace_id ?? '', grants: [], session: true, memberships: memberships.map(m => ({ workspaceId: m.workspace_id, role: m.role })) };
 if (request.method !== 'GET' && (!request.headers.has('origin') || !passesCsrfCheck(request, env))) return Response.json({ error: 'cross-origin request rejected' }, { status: 403 });
 if (path === '/api/mcp/connections' && request.method === 'GET') {
  return Response.json({ connections: await listAgentConnections(env, user.id) });
 }
 if (path.startsWith('/api/mcp/connections/') && request.method === 'DELETE') {
  const id = path.slice('/api/mcp/connections/'.length);
  const p = await accessLookups(env.DB).principalById(id);
  if (!p || p.user_id !== user.id) return Response.json({ error: 'not found' }, { status: 404 });
  // Cleanup is best effort; denial is durable in D1 even when KV cannot be reached.
  await forWorkspace(env.DB, p.workspace_id).access.principals.disable(id, Math.floor(Date.now() / 1000));
  ctx.waitUntil(revokeAgentConnection(env, user.id, id, api).catch(() => {}));
  return Response.json({ revoked: true });
 }
 if (path !== '/oauth/authorize') return Response.json({ error: 'not found' }, { status: 404 });
 try {
  if (request.method === 'GET') {
   const authRequest = await api.parseAuthRequest(request);
   if (authRequest.scope.some(s => s !== 'inbox-angel' && s !== 'offline_access')) return Response.json({ error: 'invalid_scope' }, { status: 400 });
   const description = await api.describeConsent(authRequest), consent = await api.beginConsent(authRequest);
   const choices: string[] = [];
   for (const m of memberships) {
    const scope = forWorkspace(env.DB, m.workspace_id);
    const products = await scope.access.products.list();
    for (const d of await scope.domains.list()) {
     choices.push(choice({ workspaceId: m.workspace_id, domain: d.domain }, `${m.workspace_id} / ${d.domain}`));
     for (const product of products) if ((await scope.access.products.mappings(product.id)).some(map => map.domain_id === d.id)) choices.push(choice({ workspaceId: m.workspace_id, productId: product.id, domain: d.domain }, `${m.workspace_id} / ${product.name} / ${d.domain}`));
    }
   }
   const headers = new Headers(consent.headers); headers.set('Content-Type', 'text/html; charset=utf-8'); headers.set('Cache-Control', 'no-store');
   return new Response(consentPage(`<h1>Authorize Inbox Angel agent</h1>${consentIdentity(description, url.origin)}<form method="post"><input type="hidden" name="handle" value="${escape(consent.handle)}"><fieldset><legend>Select exact resources</legend>${choices.join('')}</fieldset><fieldset><legend>Or preauthorize one exact new domain for onboarding</legend><label>Workspace<select name="workspaceId"><option value="">None</option>${memberships.map(m => `<option>${escape(m.workspace_id)}</option>`).join('')}</select></label><label>Domain<input name="domain" placeholder="mail.example.com"></label></fieldset><fieldset><legend>Allowed actions</legend>${ACCESS_ACTIONS.filter(a => a !== 'access:manage').map(a => `<label><input type="checkbox" name="actions" value="${a}">${a}</label><br>`).join('')}</fieldset><label>Expires in days<input type="number" name="days" min="1" max="30" value="7"></label><button>Authorize selected access</button></form>`), { headers });
  }
  if (request.method === 'POST') {
   if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return Response.json({ error: 'form required' }, { status: 415 });
   const form = await request.formData(), actions = form.getAll('actions');
   if (!validActions(actions) || actions.includes('access:manage')) return Response.json({ error: 'Select allowed actions' }, { status: 400 });
   const selections = form.getAll('selection').map(s => JSON.parse(String(s)) as { workspaceId: string; productId?: string; domain: string });
   if (form.get('domain')) selections.push({ workspaceId: String(form.get('workspaceId') ?? ''), domain: String(form.get('domain')).trim().toLowerCase() });
   const days = Number(form.get('days'));
   if (!selections.length || selections.length > 100 || !Number.isInteger(days) || days < 1 || days > 30) return Response.json({ error: 'Select finite resources and expiry' }, { status: 400 });
   // Validate every tuple/action using exactly the same live policy as REST/MCP.
   for (const s of selections) {
    if (!s.domain || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(s.domain)) return Response.json({ error: 'Exact domain required' }, { status: 400 });
    if (s.productId) {
     const scope = forWorkspace(env.DB, s.workspaceId);
     if (!await scope.access.products.get(s.productId)) return Response.json({ error: 'Product unavailable' }, { status: 403 });
     const existing = await scope.domains.getByName(s.domain);
     if (existing && !(await scope.access.products.mappings(s.productId)).some(m => m.domain_id === existing.id)) return Response.json({ error: 'Domain is not mapped to product' }, { status: 403 });
    }
    for (const action of actions) await authorizeResource(env.DB, actor, action, s);
   }
   const approved = await api.approveConsent(request, String(form.get('handle') ?? ''), { scope: ['inbox-angel'] });
   const principalId = crypto.randomUUID(), workspaceId = selections[0]!.workspaceId, now = Math.floor(Date.now() / 1000), expiresAt = now + days * 86400;
   await forWorkspace(env.DB, workspaceId).access.principals.create({ id: principalId, name: `Agent ${approved.request.clientId}`.slice(0, 80), kind: 'human', user_id: user.id });
   try {
    for (const s of selections) await forWorkspace(env.DB, s.workspaceId).access.grants.create({ id: crypto.randomUUID(), workspace_id: s.workspaceId, principal_id: principalId, product_id: s.productId ?? null, domain: s.domain, actions: JSON.stringify(actions), expires_at: expiresAt });
    const local = mcpInstallation(env);
    const record: AgentConnection = { principalId, userId: user.id, workspaceId, clientId: approved.request.clientId, name: `Agent ${approved.request.clientId}`.slice(0, 80), createdAt: now, expiresAt };
    await forWorkspace(env.DB, workspaceId).settings.set(`${prefix}${principalId}`, JSON.stringify(record));
    const completed = await api.completeAuthorization({ request: approved.request, userId: user.id, scope: ['inbox-angel'], props: { principalId, ...local }, metadata: { principalId }, revokeExistingGrants: false });
    const headers = new Headers(approved.headers); headers.set('Location', completed.redirectTo); headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 302, headers });
   } catch (error) {
    await forWorkspace(env.DB, workspaceId).access.principals.disable(principalId, now);
    throw error;
   }
  }
  return Response.json({ error: 'method not allowed' }, { status: 405 });
 } catch (e) {
  if (e instanceof AuthorizationError) return Response.json({ error: e.code, error_description: e.description }, { status: 400 });
  return Response.json({ error: 'Authorization rejected' }, { status: 403 });
 }
}
function choice(value: unknown, label: string) { return `<label><input type="checkbox" name="selection" value="${escape(JSON.stringify(value))}">${escape(label)}</label><br>`; }
