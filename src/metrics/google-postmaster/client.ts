// Provider contract checked against REST v2 and its JSON discovery document on 2026-10-25.
// https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query
// https://gmailpostmastertools.googleapis.com/$discovery/rest?version=v2
// The guide's sample still uses old startDate/endDate; REST/discovery define nested TimeQuery.
import type { MetricWindow, GoogleStatus } from '../contracts';
import { METRICS, type DomainStat } from './normalize';
export const GOOGLE_POSTMASTER_SCOPE='https://www.googleapis.com/auth/postmaster.traffic.readonly';
export interface GoogleOAuthConfig { clientId:string; clientSecret:string }
export class GoogleProviderError extends Error {
 constructor(readonly reason:GoogleStatus) {super(`Google Postmaster: ${reason}`);this.name='GoogleProviderError';}
}
const failure=(status:number)=>new GoogleProviderError(status===403?'permission_denied':status===401?'token_revoked':status===429?'rate_limited':'provider_error');
export async function queryStats(domain:string,accessToken:string,window:MetricWindow,fetcher:typeof fetch=fetch):Promise<DomainStat[]> {
 if(!Number.isFinite(window.since)||!Number.isFinite(window.until)||window.since>window.until)throw new Error('Invalid metrics window');
 const date=(n:number)=>{const d=new Date(n*1000);return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};};
 let pageToken:string|undefined; const seen=new Set<string>(); const rows:DomainStat[]=[];
 // A DAILY query yields at most one result per metric per day. Reject token loops/excess pages.
 const maxPages=(Math.floor((window.until-window.since)/86400)+2)*METRICS.length+1;
 for(let page=0;page<maxPages;page++) {
  let response:Response;
  try {response=await fetcher(`https://gmailpostmastertools.googleapis.com/v2/domains/${encodeURIComponent(domain)}/domainStats:query`,{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({metricDefinitions:METRICS,timeQuery:{dateRanges:{dateRanges:[{start:date(window.since),end:date(window.until)}]}},aggregationGranularity:'DAILY',pageSize:200,...(pageToken?{pageToken}:{})})});}catch{throw new GoogleProviderError('provider_error');}
  if(!response.ok)throw failure(response.status);
  let body:{domainStats?:DomainStat[];nextPageToken?:string};
  try {body=await response.json();}catch{throw new GoogleProviderError('provider_error');}
  if(body.domainStats!==undefined&&!Array.isArray(body.domainStats))throw new GoogleProviderError('provider_error');
  rows.push(...(body.domainStats??[]));
  if(!body.nextPageToken)return rows;
  if(typeof body.nextPageToken!=='string'||seen.has(body.nextPageToken))throw new GoogleProviderError('provider_error');
  pageToken=body.nextPageToken;seen.add(pageToken);
 }
 throw new GoogleProviderError('provider_error');
}
export async function exchangeGoogleToken(config:GoogleOAuthConfig,grant:{refreshToken:string}|{code:string;redirectUri:string;codeVerifier:string},fetcher:typeof fetch=fetch) {
 const params=new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,...('refreshToken'in grant?{grant_type:'refresh_token',refresh_token:grant.refreshToken}:{grant_type:'authorization_code',code:grant.code,redirect_uri:grant.redirectUri,code_verifier:grant.codeVerifier})});
 let response:Response;try{response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params});}catch{throw new GoogleProviderError('provider_error');}
 let result:{access_token?:string;refresh_token?:string;expires_in?:number;scope?:string;error?:string};
 try{result=await response.json();}catch{throw new GoogleProviderError('provider_error');}
 if(!response.ok)throw result.error==='invalid_grant'?new GoogleProviderError('token_revoked'):failure(response.status);
 if(typeof result.access_token!=='string'||!result.access_token)throw new GoogleProviderError('provider_error');
 if(result.scope&&!result.scope.split(' ').includes(GOOGLE_POSTMASTER_SCOPE))throw new GoogleProviderError('permission_denied');
 return {access:result.access_token,refresh:result.refresh_token??('refreshToken'in grant?grant.refreshToken:undefined),expiresAt:Math.floor(Date.now()/1000)+(typeof result.expires_in==='number'?result.expires_in:3600)};
}
