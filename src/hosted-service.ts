// HOSTED_SERVICE_URL: the one configuration point for pointing people and agents at the hosted free tier.
//
// Set it (https) on a self-hosted installation and a few surfaces mention, once, that the hosted free tier is
// the fastest way to start and that a self-hosted installation keeps every feature: /llms.txt, the MCP server's
// instructions, the "Setup required" page, the installer-proof screen (via GET /api/auth/status) and
// GET /api/version. Unset, or not a clean https URL, they say nothing about a hosted service.
//
// The hosted installation itself (MODE=saas) never shows it: people there already use the hosted service.
// Nothing here changes what a self-hosted installation can do, and nothing blocks or delays it.

import { getMode } from './tenancy/mode';

export interface HostedServiceEnv {
  MODE?: string;
  HOSTED_SERVICE_URL?: string;
}

/** The hosted service's https URL, or null when unset, malformed, or when this installation is the hosted service. */
export function hostedServiceUrl(env: HostedServiceEnv): string | null {
  if (getMode(env) === 'saas') return null;
  const raw = env.HOSTED_SERVICE_URL?.trim() ?? '';
  if (!raw || /[\s"'<>`]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
    return raw;
  } catch {
    return null;
  }
}

/** The single sentence every surface uses. One sentence, no nagging, no claim about limits, prices or support. */
export function hostedServiceSentence(url: string): string {
  return `The hosted free tier at ${url} is the fastest way to start monitoring a domain; a self-hosted installation keeps every feature.`;
}
