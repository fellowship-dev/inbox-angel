# Domain audit fleet

A repeatable flow that audits the email authentication (SPF, DKIM, DMARC, MX, MTA-STS, DNS host) of a
list of domains, in parallel across several devboxes. DNS-over-HTTPS and public pages only.

## Guardrails (read first)

1. **Aggregates are publishable only with Max's approval.** Nothing from `out/` leaves the repo owner's control until they say so.
2. **Per-domain results are never published or indexed.** Not in issues, PRs, commits, blog posts, dashboards or screenshots.
3. **Cold-outreach use needs Max's approval per batch.** Never contact anyone from a result without it.
4. **Seed lists and results are not committed.** They name third-party domains. Everything lives under `tools/audit-fleet/out/`, which is git-ignored. Don't force-add it, and keep third-party names out of commit messages and PR text.
5. **Read-only, no logins.** Sourcing uses public listings and unauthenticated APIs; the audit sends DNS queries only. No tokens, no accounts, no scraping behind auth.
6. Aggregate tables fold groups smaller than 5 into `other (<5)` so rows can't single out a domain.

## Layout

```
tools/audit-fleet/
  seeds/hn.ts        Show HN (Algolia API) + "What are you working on?" threads
  seeds/github.ts    repo homepages from README-mention searches (unauthenticated search API)
  seeds/build.ts     combine raw-*.csv -> out/seeds.csv (dedupe, cap, source mix)
  run.ts             audit a CSV (supports --shard i/n)
  merge.ts           combine shard outputs
  lib/               csv, shard, domain (PSL + platform filter), doh client, checker seam, aggregate
  out/               (ignored) seeds, results, aggregates
```

Requires Node >= 22.18 (runs the `.ts` files directly) and a checkout of this repo. No `npm install` is needed for the fleet itself.

## 1. Build the seed list (once, on one box)

```bash
cd tools/audit-fleet
mkdir -p out/seeds
node -e "fetch('https://publicsuffix.org/list/public_suffix_list.dat').then(r=>r.text()).then(t=>require('fs').writeFileSync('out/seeds/psl.dat',t))"
node seeds/hn.ts out/seeds          # ~10 min
node seeds/github.ts out/seeds      # ~30-60 min: unauthenticated search is limited to 10 requests/min
node seeds/build.ts out/seeds 1400  # -> out/seeds.csv, out/seeds-summary.json
```

### Method

| Source | How | Notes |
| --- | --- | --- |
| Show HN | `hn.algolia.com/api/v1` `tags=show_hn`: keyword queries (resend, supabase, saas, auth, ...) over all time, plus monthly windows of the last 30 months with points >= 3. The post's `url` is the candidate. | Public API, no key. |
| "What are you working on?" threads | Ask HN threads found via Algolia; top-level comment URLs are extracted. | Skews to hobby/indie products. |
| GitHub | `api.github.com/search/repositories` for `resend in:readme`, `supabase auth in:readme`, `topic:saas`, ... sliced by star band to get past the 1,000 result cap; the repo's `homepage` field is the candidate. | **Unauthenticated** (10 req/min). Slow on purpose. |
| Product Hunt | Public pages return 403 (bot challenge) without a browser session. **Not used.** | Don't work around it. |
| madewithsupabase.com | The listing is client-rendered from a backend API and the sitemap only lists the home page, so there is no public static list to read. **Not used.** | Same: no login, no key extraction. |

Filtering and dedupe (`lib/domain.ts`):
- URL -> hostname -> registrable domain via the Public Suffix List (ICANN section; falls back to a built-in list).
- Dropped: hosting/site-builder subdomains (`*.vercel.app`, `*.lovable.app`, `*.netlify.app`, `*.pages.dev`, `*.github.io`, ...), and non-product sites (code hosts, social, stores, media).
- Dedupe by registrable domain; every domain keeps all the sources that found it (`sources` column, `|` separated).
- `build.ts` caps to the target deterministically (`lib/select.ts`): multi-source and Resend/Supabase-keyword hits first, then GitHub up to 500, then the rest alternating between HN sources in hash order (no hand-picking).

Known limits: HN skews English-speaking and technical; "small software product" is approximated by "someone posted a custom domain for a project"; some seeds will be dead or parked (counted as `nonexistent`).

## 2. Run the audit

Single box:

```bash
cd tools/audit-fleet
node run.ts --in out/seeds.csv            # all domains -> out/results.jsonl, out/aggregate.json, out/run-meta.json
```

Options: `--shard i/n` (1-based), `--concurrency 10`, `--rps 20` (global DoH queries per second), `--resolvers cloudflare,google` (round-robin), `--retries 3`, `--limit N`, `--resume` (continue an interrupted run), `--out DIR`.

Politeness: one global rate limiter, alternating Cloudflare and Google DoH, exponential backoff with jitter on 429/5xx/timeouts, SERVFAIL retried. NXDOMAIN/NOERROR-empty are answers, not errors. Per domain: ~10 queries, plus ~35 DKIM-selector probes only for domains that publish SPF or MX. A wildcard guard discards DKIM hits when a random selector also resolves.

Shards are round-robin over the sorted, deduped domain list, so every box derives the same split from the same CSV.

### Checker seam

`lib/checker.ts` defines `type Checker = (domain: string) => Promise<DomainReport>`. `createLegacyChecker` is a **temporary adapter** over the current `src/email/dns-check.ts` parsers and `packages/dns-checks/src/email-service-providers.ts`, with a rate-limited DoH client of its own (the `src/` lookups swallow errors, which would hide the error rate). When `packages/dns-checks` lands, change the single `const checker = ...` line in `run.ts` to use its `checkDomain`, mapped to `DomainReport`.

## 3. Launch on N devboxes

```bash
N=4
# 1. bring up N devboxes
for i in $(seq 1 $N); do pylot devbox up inbox-angel-worker; done
```

Each devbox needs the same `out/seeds.csv` (it is not in git). Copy it to each, e.g. by `exec` with a heredoc, or rebuild it from the same `out/seeds/raw-*.csv`. Verify with a checksum, since shards only line up if the files are identical:

```bash
sha256sum tools/audit-fleet/out/seeds.csv     # same on every box
```

```bash
# 2. start shard i on devbox i (use whichever of prompt / exec your pylot version supports)
pylot devbox exec <devbox-i> -- bash -lc 'cd inbox-angel-worker/tools/audit-fleet && nohup node run.ts --in out/seeds.csv --shard i/N > out/run.log 2>&1 &'
# or: pylot devbox prompt <devbox-i> "cd tools/audit-fleet && node run.ts --in out/seeds.csv --shard i/N, then report the contents of out/run-meta.i-of-N.json"

# 3. watch progress
pylot devbox exec <devbox-i> -- tail -n 2 inbox-angel-worker/tools/audit-fleet/out/run.log

# 4. collect (when run-meta.<i>of<N>.json exists), into the local out/
pylot devbox exec <devbox-i> -- cat inbox-angel-worker/tools/audit-fleet/out/results.<i>of<N>.jsonl > out/results.<i>of<N>.jsonl
pylot devbox exec <devbox-i> -- cat inbox-angel-worker/tools/audit-fleet/out/run-meta.<i>of<N>.json > out/run-meta.<i>of<N>.json

# 5. merge
node merge.ts --dir out            # -> out/merged/{results.jsonl,aggregate.json,run-meta.json}
```

Shard files are named `results.<i>of<N>.jsonl`; `merge.ts` warns if a shard is missing, refuses mixed fleet sizes, and recomputes aggregates from the per-domain rows (it does not sum shard aggregates). Shut the devboxes down afterwards.

At ~20 queries/s per box a 1,400-domain list takes roughly an hour on one box and proportionally less when sharded; each box has its own rate limit, so N boxes means N x `--rps` against the resolvers. Keep `--rps` modest when N is large.

## Reading the output

- `results[.IofN].jsonl`: one `DomainReport` per line. **Private.**
- `aggregate.json`: counts and percentages over `analysed` domains (exist, no resolver errors on core lookups). `totals` shows how many were excluded as `nonexistent` or `unreliable`. Tables: `spf`, `dmarc`, `dkim`, `mail`, `senders` (SPF includes + unambiguous DKIM selectors), `dnsHosts` (NS-derived), `mxProviders`. **Publishable only with approval.**
- `run-meta.json`: runtime, query count, retries, final failures. `errors.domainRate` in the aggregate is the share of domains with any error.
- DKIM can only be found for selectors we probe, so "DKIM found" is a lower bound.
