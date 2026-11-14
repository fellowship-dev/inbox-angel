# Third-party test fixtures

Real DMARC aggregate-report emails, copied unmodified (bytes as upstream) so the known-reporter registry
(`src/dmarc/known-reporters.ts`) is tested against what receivers actually send, not against our own idea of it.
They are test data only: nothing here is shipped in the Worker bundle. Each source's licence file sits next to its fixtures.

| Directory | Upstream | Commit | Files | Licence |
|---|---|---|---|---|
| `third-party/mox/` | https://github.com/mjl-/mox (`dmarcdb/`, `dmarcrpt/` testdata) | `b32f0de` | `google.eml`, `outlook.eml`, `yahoo.eml`, `mailru.eml`, `xs4all.eml` | MIT (`LICENSE.MIT`; the MPL-2.0 text is kept because mox ships it for its Public Suffix List, not for these files) |
| `third-party/freitagsrunde/` | https://github.com/freitagsrunde/dmarc-report-aggregator | `1967d79` | `yahoo.eml`, `aol.eml`, `fastmail.eml` | MIT (`LICENSE`, Copyright (c) 2023 Maximilian Haye) |
| `third-party/parsedmarc/` | https://github.com/domainaware/parsedmarc (`samples/aggregate/`) | `70a0ea0` | `mimecast-weird-gzip.eml` | Apache-2.0 (`LICENSE`) |

## Read but not copied

- `tadamcz/mail-auth@29cea4c`, `resources/dmarc-feedback/104.eml` (Stalwart test data): an Amazon SES report. Its licence was not confirmed, so it is cited as evidence for the `amazon-ses` registry entry and not copied.
- parsedmarc's 2026 security advisories (GHSA) and CHANGELOG: read for ideas only. `test/hosted/hostile-parsedmarc.test.ts` re-creates the *classes* of hostile input with our own generators. parsedmarc is Apache-2.0 for its samples; its code and any GPL/AGPL project's code were not used.

## Changes to fixtures

None to the files. Where a test needs the carrier to look authenticated (the fixtures were received by other servers, so their
`Authentication-Results` name those servers), the test rewrites only the `Authentication-Results` header to name the test's `AUTHSERV_ID`,
and says so in the test.

## Adding one

Copy the file byte for byte, copy the licence, add a row above, cite it in the registry entry's `evidence`.
