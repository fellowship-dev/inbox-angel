import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { accessLookups, globalQueries } from '@inbox-angel/db';
import type { BoundEnv } from '../index';
import type { AccessSubject } from '../access/principal';
import { resolveAccessSubject } from '../access/resolve';
import { isSaas } from './config';
import { resolveApiKey } from './api-keys';
import { mcpInstallation } from '../mcp/discovery';
import { handleMcpConnections } from '../mcp/connections';

export interface McpIdentity { principalId: string; issuer: string; resource: string; credentialId?: string }
export type McpHandler = { fetch(request: Request, env: BoundEnv, ctx: ExecutionContext & { props: McpIdentity }): Promise<Response> | Response };
export type DefaultHandler = { fetch(request: Request, env: BoundEnv, ctx: ExecutionContext): Promise<Response> | Response };

/** Re-resolve the current D1 identity and finite grant set on every request AND every refresh. */
export async function resolveMcpIdentity(env: BoundEnv, props: unknown): Promise<AccessSubject | null> {
 if (!props || typeof props !== 'object') return null;
 const p = props as McpIdentity, local = mcpInstallation(env);
 if (p.issuer !== local.issuer || p.resource !== local.resource || typeof p.principalId !== 'string') return null;
 const subject = await resolveAccessSubject(env.DB, p.principalId);
 if (!subject) return null;
 if (subject.kind === 'human') {
  const user = subject.userId && await globalQueries(env.DB).users.byId(subject.userId);
  if (!user || (isSaas(env) && !user.email_verified)) return null;
 }
 const now = Math.floor(Date.now() / 1000);
 if (p.credentialId) {
  const key = await accessLookups(env.DB).credentialById(p.credentialId);
  if (!key || key.principal_id !== p.principalId || key.revoked_at !== null || key.expires_at <= now) return null;
  subject.credentialId = p.credentialId;
 }
 const live = subject.grants.filter(g => g.revokedAt === null && g.expiresAt > now && (subject.kind !== 'human' || subject.memberships?.some(m => m.workspaceId === g.workspaceId)));
 if (!live.length) return null;
 return { ...subject, grants: live };
}

/** Combined Workers OAuth provider. Protected handler is injected to avoid a Worker/server import cycle. */
export async function createMcpProvider(env: BoundEnv, origin: string, handler: McpHandler, fallback: DefaultHandler) {
 const { OAuthProvider, OAuthError } = await import('@cloudflare/workers-oauth-provider');
 const local = mcpInstallation(env, origin);
 if (!env.OAUTH_KV) throw new Error('Configure instance-owned OAUTH_KV');
 const dcrEnabled = env.MCP_DCR_ENABLED === '1';
 const options: OAuthProviderOptions<BoundEnv> = {
  apiRoute: '/mcp',
  apiHandler: { async fetch(request, env, ctx) {
   const props = ctx.props as McpIdentity;
   if (!(await resolveMcpIdentity(env, props))) return Response.json({ error: 'invalid_token' }, { status: 401 });
   return handler.fetch(request, env, ctx as ExecutionContext & { props: McpIdentity });
  } },
  defaultHandler: { async fetch(request, env, ctx) {
   return await handleMcpConnections(request, env, ctx, options) ?? fallback.fetch(request, env, ctx);
  } },
  authorizeEndpoint: `${local.issuer}/oauth/authorize`,
  tokenEndpoint: `${local.issuer}/oauth/token`,
  ...(dcrEnabled ? { clientRegistrationEndpoint: `${local.issuer}/oauth/register` } : {}),
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: local.resource, authorization_servers: [local.issuer], resource_name: 'Inbox Angel' },
  scopesSupported: ['inbox-angel'], requiredScopes: ['inbox-angel'],
  accessTokenTTL: 900, refreshTokenTTL: 30 * 86400,
  async resolveExternalToken({ token, env }) {
   const key = await resolveApiKey(env.DB, token);
   if (!key) return null;
   const props: McpIdentity = { principalId: key.access.principalId, credentialId: key.keyId, ...local };
   return await resolveMcpIdentity(env, props) ? { props, audience: local.resource } : null;
  },
  async tokenExchangeCallback({ props, env, resource }) {
   if (resource !== local.resource || !(await resolveMcpIdentity(env, props))) throw new OAuthError('invalid_grant', { description: 'Connection revoked or expired' });
  },
 };
 return new OAuthProvider(options);
}

/** Route only protocol/connection endpoints through OAuth; other Worker behavior remains intact. */
export function isMcpOAuthPath(path: string): boolean {
 return path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-') || path === '/api/mcp/connections' || path.startsWith('/api/mcp/connections/');
}

export function withMcpAuthorization<T extends DefaultHandler>(worker: T, handler: McpHandler): T {
 return { ...worker, async fetch(request: Request, env: BoundEnv, ctx: ExecutionContext) {
  if (!isMcpOAuthPath(new URL(request.url).pathname)) return worker.fetch(request, env, ctx);
  try { return await (await createMcpProvider(env, new URL(request.url).origin, handler, worker)).fetch(request, env, ctx); }
  catch { return Response.json({ error: 'Agent authorization unavailable' }, { status: 503 }); }
 } };
}
