import { it, expect } from 'vitest';
import { makeTenant } from '../helpers/tenant';
import { getGoogleEvidence } from '../../src/metrics/store';
it('a fresh report reads precise missing provider evidence locally without a provider grant',async()=>{
 const tenant=makeTenant();const domainId=Number((await tenant.scope.domains.insert({domain:'example.com',rua_address:''})).meta.last_row_id);
 expect(await getGoogleEvidence(tenant.scope,domainId,{since:1790812800,until:1790985600})).toMatchObject({status:'unavailable',reason:'not_connected',source:'google-postmaster-v2',data:null});
});
