// Deployment mode. Self-host is one operator's own Cloudflare account, starting with one implicit workspace
// (people can create more: docs/workspaces.md); saas is many workspaces, each with its own Cloudflare credentials.

export type Mode = 'selfhost' | 'saas';

export function getMode(env: { MODE?: string }): Mode {
  return env.MODE?.trim().toLowerCase() === 'saas' ? 'saas' : 'selfhost';
}
