// Deployment mode. Self-host is one implicit workspace on the operator's own Cloudflare
// account; saas is many workspaces, each with its own Cloudflare credentials.

export type Mode = 'selfhost' | 'saas';

export function getMode(env: { MODE?: string }): Mode {
  return env.MODE?.trim().toLowerCase() === 'saas' ? 'saas' : 'selfhost';
}
