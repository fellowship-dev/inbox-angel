import type { Env } from '../index';
/** One installation, one issuer/resource. Never derive a trusted audience from an arbitrary Host header. */
export function mcpInstallation(env: Pick<Env, 'BETTER_AUTH_URL' | 'PUBLIC_BASE_URL'>, requestOrigin?: string) {
 const configured = env.BETTER_AUTH_URL || env.PUBLIC_BASE_URL;
 if (!configured) throw new Error('Configure BETTER_AUTH_URL for agent authorization');
 const url = new URL(configured);
 if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Agent issuer must be an HTTPS origin');
 const issuer = url.origin;
 if (requestOrigin && new URL(requestOrigin).origin !== issuer) throw new Error('Wrong installation origin');
 return { issuer, resource: `${issuer}/mcp` };
}
