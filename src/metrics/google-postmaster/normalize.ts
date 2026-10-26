// MetricDefinition/QueryDomainStatsResponse are the v2 authority, not the v1 trafficStats shape.
// https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/MetricDefinition
// https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/QueryDomainStatsResponse
// v2 exposes no denominator or unit metadata: preserve numeric rates unchanged as provider-rate.
import type { MetricObservation, MetricWindow } from '../contracts';
export const METRICS = [
 {name:'spam_rate',baseMetric:{standardMetric:'SPAM_RATE'}},
 ...['spf','dkim','dmarc'].map(auth => ({name:`${auth}_success_rate`,baseMetric:{standardMetric:'AUTH_SUCCESS_RATE'},filter:`auth_type = "${auth}"`})),
 {name:'delivery_error_rate',baseMetric:{standardMetric:'DELIVERY_ERROR_RATE'}},
 {name:'delivery_error_count',baseMetric:{standardMetric:'DELIVERY_ERROR_COUNT'}},
] as const;
export interface GoogleDate { year:number; month:number; day:number }
export interface DomainStat { name?:string; metric?:string; date?:GoogleDate; value?:{ doubleValue?:number;floatValue?:number;intValue?:string } }
export function isoDate(date:GoogleDate):string {
 const s=`${date.year}-${String(date.month).padStart(2,'0')}-${String(date.day).padStart(2,'0')}`;
 if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)!==s) throw new Error('Invalid provider date');
 return s;
}
export function normalizeStats(stats:DomainStat[],domain:string,window:MetricWindow,fetchedAt:number):MetricObservation[] {
 return stats.map(row => {
  const metric=METRICS.find(m=>m.name===row.metric);
  if (!metric || !row.date || !row.name?.startsWith(`domains/${domain}/domainStats/`)) throw new Error('Invalid provider metric identity');
  const day=isoDate(row.date), seconds=Date.parse(`${day}T00:00:00Z`)/1000;
  if (seconds<Math.floor(window.since/86400)*86400 || seconds>window.until) throw new Error('Provider date outside requested range');
  const value=row.value?.doubleValue ?? row.value?.floatValue ?? row.value?.intValue;
  if (typeof value!=='number' && typeof value!=='string' || typeof value==='number' && !Number.isFinite(value) || typeof value==='string' && !/^\d+$/.test(value)) throw new Error('Invalid provider numeric value');
  return {sourceId:row.name,metric:metric.name,definition:metric.baseMetric.standardMetric,filter:'filter' in metric?metric.filter:null,value,
   unit:metric.name.endsWith('_count')?'messages':'provider-rate',denominator:null,periodStart:day,periodEnd:day,fetchedAt,status:'available',source:'google-postmaster-v2',
   population:metric.name==='spam_rate'?'Google-reported user spam complaints for eligible Gmail domain traffic; denominator not supplied':'Google Postmaster eligible Gmail domain traffic; denominator not supplied',coverage:'shared-domain'};
 });
}
