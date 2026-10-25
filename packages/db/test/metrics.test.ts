import { it, expect } from 'vitest';
import { freshDb } from './helpers';
import { forWorkspace, exportQueries, IMPLICIT_WORKSPACE_ID } from '../src';
it('exports sanitized observations and provider status without encrypted grants; workspace cascade clears both',async()=>{
 const db=freshDb();const scope=forWorkspace(db,IMPLICIT_WORKSPACE_ID);const domainId=Number((await scope.domains.insert({domain:'example.com',rua_address:''})).meta.last_row_id);
 await scope.metrics.connect(domainId,'fixture-id','ia1.fixture-encrypted');
 await scope.metrics.write(domainId,'fixture-id',[{metric:'spam_rate',periodStart:'2026-10-01',periodEnd:'2026-10-01',sourceId:'opaque',value:0} as any]);
 const exported=exportQueries(db,IMPLICIT_WORKSPACE_ID);const connections=await exported.small.google_postmaster_connections();expect(connections).toMatchObject([{id:'fixture-id',status:'connected'}]);expect(JSON.stringify(connections)).not.toContain('ia1.');
 expect(await exported.paged.metric_observations(0,2)).toMatchObject([{metric:'spam_rate',source_id:'opaque',payload:expect.stringContaining('"value":0')}]);expect(await exportQueries(db,'foreign').paged.metric_observations(0,2)).toEqual([]);
 db.sqlite.prepare('DELETE FROM workspaces WHERE id = ?').run(IMPLICIT_WORKSPACE_ID);
 expect(db.sqlite.prepare('SELECT count(*) n FROM google_postmaster_connections').get()).toMatchObject({n:0});expect(db.sqlite.prepare('SELECT count(*) n FROM metric_observations').get()).toMatchObject({n:0});
});
