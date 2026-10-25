import type { WorkspaceScope } from '@inbox-angel/db';
import type { EvidenceSection } from '../reports/contracts';
import type { MetricObservation, MetricWindow } from './contracts';
export interface GoogleEvidence { observations:MetricObservation[];connectionStatus:string;lastAttemptAt:number|null;lastSuccessAt:number|null;stale:boolean }
/** Local read only: reports do not refresh tokens or contact Google. Successful cached observations survive failures. */
export async function getGoogleEvidence(scope:WorkspaceScope,domainId:number,window:MetricWindow):Promise<EvidenceSection<GoogleEvidence>> {
 if(!await scope.domains.getById(domainId))throw Object.assign(new Error('Domain not found'),{status:404});
 const connection=await scope.metrics.status(domainId);
 const rows=await scope.metrics.read(domainId,new Date(window.since*1000).toISOString().slice(0,10),new Date(window.until*1000).toISOString().slice(0,10));
 const observations=rows.map(row=>JSON.parse(row.payload) as MetricObservation);
 const status=connection?.status??'not_connected';
 const reason=status!=='connected'?status:observations.length?undefined:'no_data';
 return {status:observations.length?'available':(['provider_error','rate_limited','permission_denied','token_revoked'].includes(status)?'error':'unavailable'),...(reason?{reason}:{}),source:'google-postmaster-v2',window,population:'Eligible Gmail domain traffic as defined by Google Postmaster; shared-domain coverage, not product attribution or inbox placement',data:observations.length?{observations,connectionStatus:status,lastAttemptAt:connection?.lastAttemptAt??null,lastSuccessAt:connection?.lastSuccessAt??null,stale:status!=='connected'}:null};
}
