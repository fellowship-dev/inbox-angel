import { it, expect, vi } from 'vitest';
import { queryStats, exchangeGoogleToken } from '../../../src/metrics/google-postmaster/client';
import { normalizeStats } from '../../../src/metrics/google-postmaster/normalize';
const window={since:1790812800,until:1790985600};
it('uses the real v2 POST/timeQuery/MetricDefinition contract and opaque paging token',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({domainStats:[],nextPageToken:'opaque'})).mockResolvedValueOnce(Response.json({domainStats:[]}));
 expect(await queryStats('example.com','fixture',window,fetcher)).toEqual([]);
 expect(fetcher.mock.calls[0][0]).toBe('https://gmailpostmastertools.googleapis.com/v2/domains/example.com/domainStats:query');
 const body=JSON.parse(fetcher.mock.calls[0][1].body);
 expect(body).toMatchObject({aggregationGranularity:'DAILY',timeQuery:{dateRanges:{dateRanges:[{start:{year:2026,month:10,day:1},end:{year:2026,month:10,day:3}}]}},metricDefinitions:[{name:'spam_rate',baseMetric:{standardMetric:'SPAM_RATE'}},{name:'spf_success_rate',baseMetric:{standardMetric:'AUTH_SUCCESS_RATE'},filter:'auth_type = "spf"'},{name:'dkim_success_rate',baseMetric:{standardMetric:'AUTH_SUCCESS_RATE'},filter:'auth_type = "dkim"'},{name:'dmarc_success_rate',baseMetric:{standardMetric:'AUTH_SUCCESS_RATE'},filter:'auth_type = "dmarc"'},{name:'delivery_error_rate',baseMetric:{standardMetric:'DELIVERY_ERROR_RATE'}},{name:'delivery_error_count',baseMetric:{standardMetric:'DELIVERY_ERROR_COUNT'}}]});
 expect(JSON.parse(fetcher.mock.calls[1][1].body).pageToken).toBe('opaque');
});
it.each([[403,'permission_denied'],[401,'token_revoked'],[429,'rate_limited'],[503,'provider_error']])('classifies %s without exposing response content',async(status,reason)=>{
 await expect(queryStats('example.com','fixture',window,vi.fn().mockResolvedValue(new Response('sensitive provider error',{status:status as number})))).rejects.toMatchObject({reason,message:`Google Postmaster: ${reason}`});
});
it('stops repeated pagination tokens',async()=>{
 const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(Response.json({nextPageToken:'again'})));
 await expect(queryStats('example.com','fixture',window,fetcher)).rejects.toMatchObject({reason:'provider_error'});expect(fetcher).toHaveBeenCalledTimes(2);
});
it('distinguishes revoked refresh token from rate limiting',async()=>{
 await expect(exchangeGoogleToken({clientId:'fixture',clientSecret:'fixture'},{refreshToken:'fixture'},vi.fn().mockResolvedValue(Response.json({error:'invalid_grant'},{status:400})))).rejects.toMatchObject({reason:'token_revoked'});
});
it('refuses foreign-domain and out-of-window provider observations',()=>{
 const row={name:'domains/foreign.com/domainStats/id',metric:'spam_rate',date:{year:2026,month:10,day:1},value:{floatValue:0.2}};
 expect(()=>normalizeStats([row],'example.com',window,1)).toThrow();
 expect(()=>normalizeStats([{...row,name:'domains/example.com/domainStats/id',date:{year:2026,month:9,day:1}}],'example.com',window,1)).toThrow();
});
