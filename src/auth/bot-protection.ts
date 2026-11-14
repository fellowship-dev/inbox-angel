// Which bot-check keys are in force, and whether hosted sign-up is open because of them.
//
// One answer for every caller: the status route (what the page offers), the password routes (the Turnstile check), and the
// user-creation hook (every route that can create an account, OAuth included), so the server enforces what the status says.
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';
import { isSaas, type AuthEnv } from './config';

const platform = (env: AuthEnv) => forWorkspace(env.DB as D1Database, IMPLICIT_WORKSPACE_ID);

/** The Turnstile secret in force: hosted env var, else the platform setting. */
export const turnstileSecret = async (env: AuthEnv): Promise<string | undefined> =>
  (isSaas(env) ? env.TURNSTILE_SECRET_KEY : undefined) || (await platform(env).settings.get('turnstile_secret_key'))?.value || undefined;

/** The public site key the page renders the widget with. */
export const turnstileSiteKey = async (env: AuthEnv): Promise<string | null> =>
  (isSaas(env) && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : (await platform(env).settings.get('turnstile_site_key'))?.value) || null;

/**
 * Hosted without both bot-check keys: sign-up is closed (the page cannot render the widget, and the server cannot check it).
 * While closed, no route creates an account: not the password sign-up, not an invite, not an OAuth callback.
 */
export async function hostedSignupClosed(env: AuthEnv): Promise<boolean> {
  if (!isSaas(env)) return false;
  const [secret, siteKey] = await Promise.all([turnstileSecret(env), turnstileSiteKey(env)]);
  return !secret || !siteKey;
}

export const SIGNUP_CLOSED_MESSAGE = 'sign-up is unavailable: bot protection is not configured on this service';
