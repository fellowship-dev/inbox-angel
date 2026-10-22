// Deployment mode. Self-host is one implicit account on the operator's own Cloudflare
// account; saas is many accounts, each with its own Cloudflare credentials.

export type Mode = 'selfhost' | 'saas';

export function getMode(env: { MODE?: string }): Mode {
  return env.MODE?.trim().toLowerCase() === 'saas' ? 'saas' : 'selfhost';
}
