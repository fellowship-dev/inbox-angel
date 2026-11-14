import { describe, expect, it } from 'vitest';
import { parseDmarcTags as shared } from '@ready-set-mail/dns-checks/dmarc-tags';
import { enforcementLevel, parseDmarcPolicy, parseDmarcSp, parseDmarcTags } from '../src/lib/dmarc-record';

// The dashboard and the server read DMARC records with one parser; the server's cases are in test/email/dns-snapshot.test.ts.
describe('dashboard and server share one DMARC tag parser', () => {
	const records = ['v=DMARC1; p = reject', 'V = DMARC1 ;P=Reject; sp = none', 'v=DMARC1; p=reject; sp=bogus', 'v=DMARC1; p=a; p=b'];
	it.each(records)('%j', (r) => expect(parseDmarcTags(r)).toEqual(shared(r)));
	it('reads the required policies', () => {
		expect(parseDmarcPolicy('v=DMARC1; p = reject')).toBe('reject');
		expect(parseDmarcPolicy('v=DMARC1; P=Reject')).toBe('reject');
		expect(parseDmarcSp('v=DMARC1; p=reject; sp=bogus')).toBeNull();
		expect(parseDmarcSp('v=DMARC1; p=reject; sp = none')).toBe('none');
		expect(enforcementLevel('v=DMARC1; p = reject').level).toBe('full');
	});
});
