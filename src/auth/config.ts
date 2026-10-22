// Auth configuration read from the environment. Nothing here touches D1.
import type { Env } from '../index';
import { getMode } from '../tenancy/mode';

export type AuthEnv = Pick<
  Env,
  | 'DB' | 'API_KEY' | 'MODE' | 'SAAS_ENABLED' | 'OWNER_EMAIL' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'TRUSTED_ORIGINS'
  | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'
  | 'SEND_EMAIL'
>;

/** `MODE=saas`: every signup gets its own account. Anything else is self-host: one implicit account. */
export function isSaas(env: Pick<Env, 'MODE'>): boolean {
  return getMode(env) === 'saas';
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export type OAuthProviderId = 'github' | 'google';

/** OAuth providers enabled by the environment: a provider is on only when both its id and secret are set. */
export function oauthProviders(env: AuthEnv): Partial<Record<OAuthProviderId, OAuthProviderConfig>> {
  const out: Partial<Record<OAuthProviderId, OAuthProviderConfig>> = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    out.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return out;
}

export function enabledOAuthProviders(env: AuthEnv): OAuthProviderId[] {
  return Object.keys(oauthProviders(env)) as OAuthProviderId[];
}

/** Origins allowed to send cookie-authenticated, state-changing requests: this one plus TRUSTED_ORIGINS. */
export function trustedOrigins(env: AuthEnv, requestOrigin: string): string[] {
  const extra = (env.TRUSTED_ORIGINS ?? '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  return [baseUrl(env, requestOrigin), ...extra];
}

/** Public origin of the Worker: BETTER_AUTH_URL when set (custom domains behind proxies), else the request's. */
export function baseUrl(env: AuthEnv, requestOrigin: string): string {
  return (env.BETTER_AUTH_URL ?? requestOrigin).replace(/\/$/, '');
}
