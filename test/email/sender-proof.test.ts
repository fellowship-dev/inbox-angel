import { describe, it, expect } from 'vitest';
import { spfPassesFor } from '../../src/email/sender-proof';

const ar = (body: string) => `mx.cloudflare.net; ${body}`;

describe('spfPassesFor', () => {
  it('accepts one spf=pass for exactly the envelope domain', () => {
    expect(spfPassesFor(ar('dkim=none; spf=pass (ok) smtp.mailfrom=a@v.com; dmarc=none header.from=v.com'), 'v.com')).toBe(true);
  });

  it('refuses a header that carries more than one spf clause, even when one passes', () => {
    expect(spfPassesFor(ar('dmarc=none header.from=x;spf=pass smtp.mailfrom=v.com; spf=fail smtp.mailfrom=a@v.com'), 'v.com')).toBe(false);
  });
});
