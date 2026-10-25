import type { WorkspaceScope } from '@inbox-angel/db';
import { envelopeAad, TokenCrypto, type TokenMaterial } from '../../connections/crypto';
import { exchangeGoogleToken, GoogleProviderError, type GoogleOAuthConfig } from './client';
/** Connection management callers must enforce human owner policy before calling these methods. */
export async function connectGoogle(scope:WorkspaceScope,domainId:number,crypto:TokenCrypto,material:TokenMaterial|{access:string;refresh?:string;expiresAt?:number}) {
 const previous=await scope.metrics.status(domainId);const id=previous?.id??cryptoId();
 const envelope=await crypto.seal(material,envelopeAad(scope.workspaceId,id));
 await scope.metrics.connect(domainId,id,envelope);return scope.metrics.status(domainId);
}
const cryptoId=()=>crypto.randomUUID();
export const disconnectGoogle=(scope:WorkspaceScope,domainId:number)=>scope.metrics.disconnect(domainId);
export async function googleAccess(scope:WorkspaceScope,domainId:number,crypto:TokenCrypto,config:GoogleOAuthConfig,fetcher:typeof fetch=fetch) {
 const row=await scope.metrics.secret(domainId);
 if(!row||row.status==='disconnected'||!row.token_envelope)throw new GoogleProviderError('disconnected');
 const aad=envelopeAad(scope.workspaceId,row.id);let material=await crypto.open(row.token_envelope,aad);
 if(material.expired(Math.floor(Date.now()/1000))) {
  const refreshToken=material.refresh();if(!refreshToken)throw new GoogleProviderError('token_revoked');
  const next=await exchangeGoogleToken(config,{refreshToken},fetcher);const envelope=await crypto.seal(next,aad);
  if(!await scope.metrics.swapEnvelope(domainId,row.token_envelope,envelope))throw new GoogleProviderError('provider_error');
  material=await crypto.open(envelope,aad);
 } else if(!crypto.isCurrent(row.token_envelope)) {
  if(!await scope.metrics.swapEnvelope(domainId,row.token_envelope,await crypto.seal(material,aad)))throw new GoogleProviderError('provider_error');
 }
 return {id:row.id,material};
}
