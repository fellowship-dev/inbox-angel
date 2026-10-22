// Signing secret for sessions. BETTER_AUTH_SECRET wins; otherwise a random one is
// generated on first use and kept in D1 so self-hosting needs no extra setup.
// (Read per request: the Worker keeps no module-level state.)
import { forImplicitAccount } from '@inbox-angel/db';
import type { AuthEnv } from './config';

const SETTING = 'auth_secret';

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function authSecret(env: AuthEnv): Promise<string> {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  const settings = forImplicitAccount(env.DB as D1Database).settings;
  const existing = await settings.get(SETTING);
  if (existing?.value) return existing.value;
  // setIfAbsent keeps the first writer's value, so isolates racing on a fresh install agree.
  return settings.setIfAbsent(SETTING, randomSecret());
}
