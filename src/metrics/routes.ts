import { forWorkspace } from '@inbox-angel/db';
import { requireAuth, AuthError } from '../api/auth';
import { baseUrl, type AuthEnv } from '../auth/config';
import { authorizeResource } from '../access/resolve';
import { AccessDenied } from '../access/policy';
import { TokenCrypto, TokenKeyError } from '../connections/crypto';
import { challengeFor, newVerifier, randomId, signState, verifyState, OAuthStateError } from '../connections/oauth';
import { connectGoogle, disconnectGoogle } from './google-postmaster/connection';
import { exchangeGoogleToken, GOOGLE_POSTMASTER_SCOPE, GoogleProviderError } from './google-postmaster/client';
import { syncGoogleMetrics } from './google-postmaster/sync';

export type GoogleMetricsEnv=AuthEnv & {TOKEN_ENCRYPTION_KEY?:string;GOOGLE_POSTMASTER_CLIENT_ID?:string;GOOGLE_POSTMASTER_CLIENT_SECRET?:string};
const ROOT='/api/metrics/google';
const COOKIE='ia_google_postmaster';
const USED='google_postmaster_oauth_used:';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const fail=(code:string,status:number)=>json({error:code,code},status);
const cookie=(nonce:string,workspaceId:string,age:number)=>`${COOKIE}=${nonce}:${encodeURIComponent(workspaceId)}; Max-Age=${age}; Path=${ROOT}/oauth; HttpOnly; Secure; SameSite=Lax`;
const config=(env:GoogleMetricsEnv)=>env.GOOGLE_POSTMASTER_CLIENT_ID&&env.GOOGLE_POSTMASTER_CLIENT_SECRET?{clientId:env.GOOGLE_POSTMASTER_CLIENT_ID,clientSecret:env.GOOGLE_POSTMASTER_CLIENT_SECRET}:null;

/** Browser-owner adapter. Provider consent and credentials never become MCP authority. */
export async function handleGoogleMetricRoutes(request:Request,env:GoogleMetricsEnv,ctx?:Pick<ExecutionContext,'waitUntil'>):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
 if(path!==ROOT&&!path.startsWith(`${ROOT}/`))return null;
 try {
  let authenticatedRequest=request;
  let browserNonce:string|undefined;
  if(path===`${ROOT}/oauth/callback`&&method==='GET') {
   const raw=request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
   const parts=raw?.split(':');
   if(!parts||parts.length!==2||!/^[A-Za-z0-9_-]{16,128}$/.test(parts[0]))return fail('invalid_oauth_state',400);
   let workspaceId:string;try{workspaceId=decodeURIComponent(parts[1]);}catch{return fail('invalid_oauth_state',400);}
   if(!workspaceId||workspaceId.length>128)return fail('invalid_oauth_state',400);
   // Cookie selects a workspace only: requireAuth still checks current membership, then signed state binds it.
   if(request.headers.has('X-Workspace-Id')&&request.headers.get('X-Workspace-Id')!==workspaceId)return fail('invalid_oauth_state',400);
   const headers=new Headers(request.headers);headers.set('X-Workspace-Id',workspaceId);
   authenticatedRequest=new Request(request,{headers});browserNonce=parts[0];
  }
  const auth=await requireAuth(authenticatedRequest,env,ctx);
  if(!env.DB||!auth.access||auth.kind!=='session'||!auth.user)throw new AccessDenied();
  await authorizeResource(env.DB,auth.access,'access:manage',{workspaceId:auth.workspaceId});
  const scope=forWorkspace(env.DB,auth.workspaceId),cfg=config(env);
  const origin=baseUrl(env,url.origin),canonical=new URL(origin);
  if(canonical.protocol!=='https:'&&!(canonical.protocol==='http:'&&['localhost','127.0.0.1'].includes(canonical.hostname)))return fail('canonical_origin_invalid',503);
  // Mutations need a browser's exact installation Origin, even with a bearer session.
  if(!['GET','HEAD'].includes(method)&&request.headers.get('Origin')!==canonical.origin)return fail('cross_origin_request',403);
  const domainStatus=async(domainId:number)=>{
   const domain=await scope.domains.getById(domainId);if(!domain)throw Object.assign(new Error('domain_not_found'),{status:404});
   return {domainId,domain:domain.domain,...(await scope.metrics.status(domainId)??{status:'not_connected'})};
  };
  if(path===`${ROOT}/connections`&&method==='GET') {
   const domains=await scope.domains.list();return json({configured:!!cfg&&TokenCrypto.isConfigured(env),connections:await Promise.all(domains.map(domain=>domainStatus(domain.id)))});
  }
  const selected=path.match(/^\/api\/metrics\/google\/domains\/(\d+)(?:\/(sync))?$/);
  if(selected) {
   const domainId=Number(selected[1]);const status=await domainStatus(domainId);
   if(!selected[2]&&method==='GET')return json(status);
   if(!selected[2]&&method==='DELETE'){await disconnectGoogle(scope,domainId);return json(await domainStatus(domainId));}
   if(selected[2]==='sync'&&method==='POST') {
    if(!cfg||!TokenCrypto.isConfigured(env))return fail('google_postmaster_not_configured',503);
    const body=await request.json() as {since?:unknown;until?:unknown};
    if(typeof body.since!=='number'||typeof body.until!=='number'||!Number.isSafeInteger(body.since)||!Number.isSafeInteger(body.until)||body.since<0||body.since>body.until||body.until>Math.floor(Date.now()/1000))return fail('invalid_metrics_window',400);
    return json(await syncGoogleMetrics(scope,domainId,TokenCrypto.fromEnv(env),cfg,{since:body.since,until:body.until}));
   }
  }
  if(path===`${ROOT}/oauth/start`&&method==='POST') {
   if(!cfg||!TokenCrypto.isConfigured(env))return fail('google_postmaster_not_configured',503);
   const body=await request.json() as {domain_id?:unknown};
   if(typeof body.domain_id!=='number'||!Number.isSafeInteger(body.domain_id))return fail('invalid_domain_id',400);
   await domainStatus(body.domain_id);
   const nonce=randomId(),verifier=newVerifier(),now=Math.floor(Date.now()/1000),crypt=TokenCrypto.fromEnv(env);
   const state=await signState(crypt,{workspaceId:auth.workspaceId,userId:auth.user.id,nonce},verifier,{label:'google-postmaster',connectionId:String(body.domain_id)},now);
   const authorization=new URL('https://accounts.google.com/o/oauth2/v2/auth');
   authorization.search=new URLSearchParams({client_id:cfg.clientId,response_type:'code',redirect_uri:`${canonical.origin}${ROOT}/oauth/callback`,scope:GOOGLE_POSTMASTER_SCOPE,access_type:'offline',prompt:'consent',state,code_challenge:await challengeFor(verifier),code_challenge_method:'S256'}).toString();
   const response=json({authorize_url:authorization.toString(),expires_in:600});response.headers.append('Set-Cookie',cookie(nonce,auth.workspaceId,600));return response;
  }
  if(path===`${ROOT}/oauth/callback`&&method==='GET') {
   if(!cfg||!TokenCrypto.isConfigured(env))return fail('google_postmaster_not_configured',503);
   const state=url.searchParams.get('state'),nonce=browserNonce;
   if(!state||state.length>8192||!nonce)return fail('invalid_oauth_state',400);
   const now=Math.floor(Date.now()/1000),crypt=TokenCrypto.fromEnv(env);
   const verified=await verifyState(crypt,state,{workspaceId:auth.workspaceId,userId:auth.user.id,nonce},now);
   if(verified.label!=='google-postmaster'||!verified.connectionId||!/^\d+$/.test(verified.connectionId))return fail('invalid_oauth_state',400);
   const domainId=Number(verified.connectionId);await domainStatus(domainId);
   await scope.settings.deleteExpired(USED,now);
   if(!await scope.settings.claim(`${USED}${nonce}`,String(now+600)))return fail('oauth_state_used',400);
   if(url.searchParams.has('error'))return fail('provider_consent_denied',400);
   const code=url.searchParams.get('code');if(!code||code.length>8192)return fail('oauth_code_missing',400);
   const material=await exchangeGoogleToken(cfg,{code,redirectUri:`${canonical.origin}${ROOT}/oauth/callback`,codeVerifier:verified.verifier});
   // Permission and domain ownership may have changed during the provider request.
   await authorizeResource(env.DB,auth.access,'access:manage',{workspaceId:auth.workspaceId});await domainStatus(domainId);
   await connectGoogle(scope,domainId,crypt,material);
   return new Response(null,{status:303,headers:{Location:`${canonical.origin}/#/w/${encodeURIComponent(auth.workspaceId)}/settings?google_postmaster=connected`,'Set-Cookie':cookie('','',0),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  }
  return fail('not_found',404);
 } catch(error) {
  if(error instanceof AuthError)return fail('authentication_required',error.status);
  if(error instanceof AccessDenied)return fail('owner_session_required',403);
  if(error instanceof OAuthStateError)return fail('invalid_oauth_state',400);
  if(error instanceof GoogleProviderError)return fail(error.reason,502);
  if(error instanceof TokenKeyError)return fail('google_postmaster_not_configured',503);
  if(error instanceof Error&&'status'in error&&error.status===404)return fail('domain_not_found',404);
  return fail('invalid_request',400);
 }
}
