import { it, expect } from 'vitest';
import { normalizeStats } from '../../../src/metrics/google-postmaster/normalize';
it('preserves v2 metric identity, zero and original days without fabricating a range average', () => {
 const rows=normalizeStats([{name:'domains/example.com/domainStats/opaque',metric:'spam_rate',date:{year:2026,month:10,day:1},value:{doubleValue:0}}], 'example.com', {since:1790812800,until:1790985600}, 123);
 expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({metric:'spam_rate',value:0,denominator:null,periodStart:'2026-10-01',periodEnd:'2026-10-01',fetchedAt:123});
});
