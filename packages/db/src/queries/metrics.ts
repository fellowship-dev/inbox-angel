import { and, eq, gte, lte, ne, isNull } from 'drizzle-orm';
import type { Db } from '../client';
import { domains, googlePostmasterConnections as connections, metricObservations as observations } from '../schema';
export function metricQueries(db:Db,workspaceId:string) {
 const domain=(id:number)=>and(eq(connections.workspace_id,workspaceId),eq(connections.domain_id,id));
 const cols={id:connections.id,domainId:connections.domain_id,status:connections.status,lastAttemptAt:connections.last_attempt_at,lastSuccessAt:connections.last_success_at};
 return {
  status:(domainId:number)=>db.select(cols).from(connections).where(domain(domainId)).get(),
  secret:(domainId:number)=>db.select().from(connections).where(domain(domainId)).get(),
  async connect(domainId:number,id:string,envelope:string) {
   if(!await db.select({id:domains.id}).from(domains).where(and(eq(domains.id,domainId),eq(domains.workspace_id,workspaceId))).get())throw new Error('Domain not found');
   // Reconnect keeps the same identity and successful observation history.
   const previous=await this.status(domainId);
   if(previous && previous.id!==id)throw new Error('Connection identity mismatch');
   await db.insert(connections).values({id,workspace_id:workspaceId,domain_id:domainId,token_envelope:envelope}).onConflictDoUpdate({target:[connections.workspace_id,connections.domain_id],set:{token_envelope:envelope,status:'connected'}}).run();
  },
  async swapEnvelope(domainId:number,expected:string,next:string) {
   const r=await db.update(connections).set({token_envelope:next}).where(and(domain(domainId),eq(connections.token_envelope,expected),ne(connections.status,'disconnected'))).run();return (r.meta.changes??0)>0;
  },
  disconnect:(domainId:number)=>db.update(connections).set({token_envelope:null,status:'disconnected'}).where(domain(domainId)).run(),
  attempt:(domainId:number,status:string,at:number,success=false,expectedEnvelope?:string|null)=>db.update(connections).set({status,last_attempt_at:at,...(status==='token_revoked'?{token_envelope:null}:{}),...(success?{last_success_at:at}:{})}).where(and(domain(domainId),ne(connections.status,'disconnected'),expectedEnvelope===undefined?undefined:expectedEnvelope===null?isNull(connections.token_envelope):eq(connections.token_envelope,expectedEnvelope))).run(),
  async write(domainId:number,connectionId:string,rows:{metric:string;periodStart:string;periodEnd:string;sourceId:string}[]) {
   const current=await this.status(domainId);if(current?.id!==connectionId||current.status==='disconnected')throw new Error('Connection unavailable');
   for(const row of rows)await db.insert(observations).values({workspace_id:workspaceId,connection_id:connectionId,domain_id:domainId,metric:row.metric,period_start:row.periodStart,period_end:row.periodEnd,source_id:row.sourceId,payload:JSON.stringify(row)}).onConflictDoUpdate({target:[observations.connection_id,observations.domain_id,observations.metric,observations.period_start,observations.period_end,observations.source_id],set:{payload:JSON.stringify(row)}}).run();
  },
  read:(domainId:number,since:string,until:string)=>db.select({payload:observations.payload}).from(observations).where(and(eq(observations.workspace_id,workspaceId),eq(observations.domain_id,domainId),gte(observations.period_start,since),lte(observations.period_end,until))).all(),
 };
}
