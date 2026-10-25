// Fix catalog: one module per finding id (KTD2), plus the DIY steps per DNS host.
import type { CatalogFile } from './types';
import { bimiBlockedByDmarcNone } from './bimi-blocked-by-dmarc-none';
import { bimiBlockedByDmarcPct } from './bimi-blocked-by-dmarc-pct';
import { bimiLogoInvalid } from './bimi-logo-invalid';
import { bimiMissing } from './bimi-missing';
import { bimiNoCertificate } from './bimi-no-certificate';
import { dkimNotFoundForSender } from './dkim-not-found-for-sender';
import { dmarcInvalid } from './dmarc-invalid';
import { dmarcMissing } from './dmarc-missing';
import { dmarcMultiple } from './dmarc-multiple';
import { dmarcPNoneNoRua } from './dmarc-p-none-no-rua';
import { mtaStsMissing } from './mta-sts-missing';
import { multipleSpf } from './multiple-spf';
import { spfMissing } from './spf-missing';
import { spfNoAll } from './spf-no-all';
import { spfOpen } from './spf-open';
import { spfOver10Lookups } from './spf-over-10-lookups';
import { spfPermerror } from './spf-permerror';

export { DNS_HOST_STEPS } from './dns-hosts';
export type * from './types';

export const CATALOG: Readonly<Record<string, CatalogFile>> = {
  'bimi-blocked-by-dmarc-none': bimiBlockedByDmarcNone,
  'bimi-blocked-by-dmarc-pct': bimiBlockedByDmarcPct,
  'bimi-logo-invalid': bimiLogoInvalid,
  'bimi-missing': bimiMissing,
  'bimi-no-certificate': bimiNoCertificate,
  'dkim-not-found-for-sender': dkimNotFoundForSender,
  'dmarc-invalid': dmarcInvalid,
  'dmarc-missing': dmarcMissing,
  'dmarc-multiple': dmarcMultiple,
  'dmarc-p-none-no-rua': dmarcPNoneNoRua,
  'mta-sts-missing': mtaStsMissing,
  'multiple-spf': multipleSpf,
  'spf-missing': spfMissing,
  'spf-no-all': spfNoAll,
  'spf-open': spfOpen,
  'spf-over-10-lookups': spfOver10Lookups,
  'spf-permerror': spfPermerror,
};
