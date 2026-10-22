// Signing secret for sessions. BETTER_AUTH_SECRET wins; otherwise a random one is
// generated on first use and kept in D1 so self-hosting needs no extra setup.
import { forImplicitAccount } from '@inbox-angel/db';
import type { AuthEnv } from './config';

const SETTING = 'auth_secret';
const cache = new WeakMap<object, string>();

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function authSecret(env: AuthEnv): Promise<string> {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  const db = env.DB as D1Database;
  const hit = cache.get(db);
  if (hit) return hit;
  // setIfAbsent keeps the first writer's value, so isolates racing on a fresh install agree.
  const secret = await forImplicitAccount(db).settings.setIfAbsent(SETTING, randomSecret());
  cache.set(db, secret);
  return secret;
}
