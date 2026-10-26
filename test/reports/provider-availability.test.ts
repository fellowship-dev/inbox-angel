import { it, expect } from 'vitest';
import { makeTenant } from '../helpers/tenant';
import { getGoogleEvidence } from '../../src/metrics/store';
import { getDomainReport } from '../../src/reports/service';
import { createResolver } from '@inbox-angel/dns-checks';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
it('a fresh report reads precise missing provider evidence locally without a provider grant',async()=>{
 const tenant=makeTenant();const domainId=Number((await tenant.scope.domains.insert({domain:'example.com',rua_address:''})).meta.last_row_id);
 expect(await getGoogleEvidence(tenant.scope,domainId,{since:1790812800,until:1790985600})).toMatchObject({status:'unavailable',reason:'not_connected',source:'google-postmaster-v2',data:null});
});
it('the shared report includes stored provider observations and preserves an observed zero',async()=>{
 const tenant=makeTenant();const domainId=Number((await tenant.scope.domains.insert({domain:'example.com',rua_address:''})).meta.last_row_id);
 await tenant.scope.metrics.connect(domainId,'google-fixture','sealed-fixture');
 const observation={sourceId:'domains/example.com/domainStats/20261023',metric:'spam_rate',definition:'SPAM_RATE',filter:null,value:0,unit:'provider-rate',denominator:null,periodStart:'2026-10-23',periodEnd:'2026-10-23',fetchedAt:1792796400,status:'available',source:'google-postmaster-v2',population:'Eligible Gmail traffic',coverage:'shared-domain'};
 await tenant.scope.metrics.write(domainId,'google-fixture',[observation]);
 const report=await getDomainReport(tenant,domainId,{resolver:createResolver({fetch:dohFetch({})}),now:1792954800});
 expect(report.sections.google).toMatchObject({status:'available',source:'google-postmaster-v2',data:{observations:[{value:0,denominator:null,unit:'provider-rate'}]}});
});
