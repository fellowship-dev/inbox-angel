import type { WorkspaceScope } from '@inbox-angel/db';
import type { TokenCrypto } from '../../connections/crypto';
import type { MetricWindow } from '../contracts';
import { getGoogleEvidence } from '../store';
import { googleAccess } from './connection';
import { GoogleProviderError, queryStats, type GoogleOAuthConfig } from './client';
import { normalizeStats } from './normalize';
/** Explicit on-demand collection only. Errors update connection state; successful history is never deleted. */
export async function syncGoogleMetrics(scope:WorkspaceScope,domainId:number,crypto:TokenCrypto,config:GoogleOAuthConfig,window:MetricWindow,fetcher:typeof fetch=fetch) {
 const domain=await scope.domains.getById(domainId);if(!domain)throw Object.assign(new Error('Domain not found'),{status:404});
 const fetchedAt=Math.floor(Date.now()/1000);
 try {
  const {id,material}=await googleAccess(scope,domainId,crypto,config,fetcher);
  const rows=normalizeStats(await queryStats(domain.domain,material.access(),window,fetcher),domain.domain,window,fetchedAt);
  await scope.metrics.write(domainId,id,rows);
  await scope.metrics.attempt(domainId,rows.length?'connected':'no_data',fetchedAt,true);
 } catch(error) {
  await scope.metrics.attempt(domainId,error instanceof GoogleProviderError?error.reason:'provider_error',fetchedAt);
 }
 return getGoogleEvidence(scope,domainId,window);
}
