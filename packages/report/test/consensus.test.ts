// KTD3 finding consensus across up to three resolver runs: one test per row of the plan's table.
import { describe, expect, it } from 'vitest';
import { consensus, type ConsensusResult } from '../src/index';
import { CHECKED, GOOGLE, makeRec } from './helpers';

const missing = () => makeRec('acme.dev', { providers: [GOOGLE] }); // no _dmarc record
const present = () => makeRec('acme.dev', { providers: [GOOGLE], dmarc: 'found', dmarcRaw: 'v=DMARC1; p=reject; rua=mailto:a@acme.dev', dmarcPolicy: 'reject', rua: ['mailto:a@acme.dev'] });
const errored = () => makeRec('acme.dev', { providers: [GOOGLE], dmarc: 'error', errors: [{ check: 'dmarc', message: 'SERVFAIL' }] });

const dmarcMissing = (runs: ReturnType<typeof makeRec>[]): ConsensusResult | undefined =>
  consensus(runs, CHECKED, ['dmarc-missing']).find(r => r.id === 'dmarc-missing');

describe('consensus (KTD3)', () => {
  it('3 producing, 0 contradicting: confirmed', () => {
    expect(dmarcMissing([missing(), missing(), missing()])).toMatchObject({ status: 'confirmed', produced: 3, contradicted: 0, errored: 0 });
  });

  it('2 producing, third errored (counts as neither): confirmed', () => {
    expect(dmarcMissing([missing(), errored(), missing()])).toMatchObject({ status: 'confirmed', produced: 2, contradicted: 0, errored: 1 });
  });

  it('2 producing, 1 contradicting with an ok lookup: unconfirmed', () => {
    expect(dmarcMissing([missing(), missing(), present()])).toMatchObject({ status: 'unconfirmed', produced: 2, contradicted: 1 });
  });

  it('1 producing, whatever the others did: unconfirmed', () => {
    expect(dmarcMissing([missing(), errored(), errored()])).toMatchObject({ status: 'unconfirmed', produced: 1, contradicted: 0, errored: 2 });
    expect(dmarcMissing([missing(), present(), present()])).toMatchObject({ status: 'unconfirmed', produced: 1, contradicted: 2 });
  });

  it('0 producing with at least two completed lookups: confirmed absent', () => {
    expect(dmarcMissing([present(), present(), present()])).toMatchObject({ status: 'absent', produced: 0, contradicted: 3 });
    expect(dmarcMissing([present(), errored(), present()])).toMatchObject({ status: 'absent', produced: 0, contradicted: 2, errored: 1 });
  });

  it('0 producing with fewer than two completed lookups: unconfirmed', () => {
    expect(dmarcMissing([present(), errored(), errored()])).toMatchObject({ status: 'unconfirmed', produced: 0, contradicted: 1, errored: 2 });
  });

  it('an error in a different check does not neutralise a contradicting run', () => {
    const other = present();
    other.errors.push({ check: 'mta-sts', message: 'fetch failed' });
    expect(dmarcMissing([missing(), missing(), other])).toMatchObject({ status: 'unconfirmed', contradicted: 1, errored: 0 });
  });

  it('covers every finding any run produced, carrying the first producing run\'s redacted finding', () => {
    const runs = [missing(), missing(), present()];
    const got = Object.fromEntries(consensus(runs, CHECKED).map(r => [r.id, r]));
    expect(got['spf-missing']).toMatchObject({ status: 'confirmed', produced: 3 });
    expect(got['dmarc-missing'].finding?.evidence[0]).toContain('_dmarc.acme.dev');
    expect(got['dmarc-missing'].status).toBe('unconfirmed');
    const monitoring = () => makeRec('acme.dev', { providers: [GOOGLE], dmarc: 'found', dmarcRaw: 'v=DMARC1; p=none; rua=mailto:jane@acme.dev', rua: ['mailto:jane@acme.dev'] });
    const blocked = consensus([monitoring(), monitoring()], CHECKED).find(r => r.id === 'bimi-blocked-by-dmarc-none');
    expect(blocked?.finding?.evidence[0]).toContain('mailto:<address>');
    expect(blocked?.finding?.evidence[0]).not.toContain('jane');
  });
});
