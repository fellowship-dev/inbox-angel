# @inbox-angel/dns-checks

Pure, runtime-agnostic email-authentication DNS checks: **SPF, DKIM, DMARC, MTA-STS, BIMI**,
MX and provider detection, over DNS-over-HTTPS with an **injectable `fetch`**.

No D1, no Cloudflare zone API, no environment globals. It runs in Workers, Node ≥ 18 and browsers.
The Inbox Angel worker and the free public checker tools share this one implementation.

```ts
import { checkDomain } from '@inbox-angel/dns-checks';

const report = await checkDomain('example.com');
report.grade;      // { level: 0|1|2|3|null, label, complete, reasons[], nextSteps[] }
report.spf;        // status 'ok'|'none'|'permerror'|'temperror', lookupCount, voidLookupCount, issues[]
report.dmarc;      // status 'found'|'none'|'multiple'|'error', record, inherited, organizationalDomain
report.dkim;       // { found[], errors[], scanned }
report.mtaSts; report.bimi; report.mx; report.providers;
```

Inject your own `fetch` (tests, proxies, other DoH servers):

```ts
import { createResolver, checkDomain } from '@inbox-angel/dns-checks';
const resolver = createResolver({ fetch: myFetch, endpoint: 'https://dns.google/resolve', timeoutMs: 3000 });
await checkDomain('example.com', { resolver });
```

## Errors are never "no record"

Every lookup is classified as exactly one of:

| status     | meaning                                              |
|------------|------------------------------------------------------|
| `ok`       | records of the requested type exist                  |
| `nodata`   | NOERROR, but no record of that type                  |
| `nxdomain` | the name does not exist                              |
| `error`    | SERVFAIL/REFUSED, timeout, HTTP error, bad JSON, malformed answer |

Only `nodata`/`nxdomain` mean "no record". Check modules map `error` to an explicit error state
(`spf.status === 'temperror'`, `dmarc.status === 'error'`, `dkim.errors`, `mtaSts.status === 'error'`, …)
and `checkDomain` returns `grade.level === null` ("Inconclusive") instead of claiming "you have no DMARC".

## Grade (Levels 0–3)

| Level | Label        | Requirement |
|-------|--------------|-------------|
| 0     | Unprotected  | no valid SPF (missing, `permerror`, `+all`/`?all`) or no usable DMARC |
| 1     | Monitoring   | valid SPF + DMARC published, not enforcing (`p=none` or `pct<100`) |
| 2     | Enforced     | valid SPF + DMARC `quarantine`/`reject` at `pct=100` |
| 3     | Hardened     | Level 2 + `p=reject`, SPF ending `-all`/`~all`, a DKIM key found, MTA-STS `mode: enforce` |

DKIM selectors are not enumerable, so a scan of common selectors only *proves* presence; its absence
is reported but never used to claim "no DKIM".
`grade.complete === false` means some non-decisive lookup failed and Level 3 could not be confirmed.

## SPF

`analyzeSpf(domain, resolver)` follows RFC 7208 §4.6.4:

* `include`, `a`, `mx`, `ptr`, `exists` and `redirect` each count one lookup; `ip4`, `ip6`, `all`, `exp` do not.
  `redirect=` is ignored (and free) when the record has an `all` mechanism.
* More than 10 lookups → `permerror`; evaluation stops as soon as the limit is crossed.
* More than 2 void lookups (NXDOMAIN or empty answers on a/mx/exists/include targets) → `permerror`.
* Include/redirect loops are detected along the active path (diamonds are fine) → `permerror`.
* Multiple SPF records at any visited name → `permerror`. An include of a name without SPF → `permerror`.
* `previewFlatten()` / `collectIps()` flatten to `ip4:`/`ip6:`; if `incomplete` is true (DNS error, loop…)
  the result must **not** be published.

## DMARC organizational domain

`organizationalDomain()` uses the Public Suffix List via [`tldts`](https://github.com/remusao/tldts)
(private suffixes such as `github.io` included): `mail.example.co.uk` → `example.co.uk`, and a bare public
suffix is never queried.
**Updating the PSL:** it ships inside `tldts`; bump the dependency (`npm update tldts`; Dependabot runs on this repo).

## Modules

`doh` · `org-domain` · `spf` · `dmarc` · `dkim` · `mx` · `mta-sts` · `bimi` · `providers` · `report`
(each importable as `@inbox-angel/dns-checks/<module>`).

BIMI checks the SVG and VMC for presence/reachability only; the VMC certificate is **not** cryptographically validated.

## Development

```
npm test                      # repo root: runs packages/dns-checks/test too
npx tsc -p packages/dns-checks
```
