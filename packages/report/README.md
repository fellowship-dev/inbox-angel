# @inbox-angel/report

Email-authentication findings, the fix catalog, multi-resolver consensus and the report model with its three
renderings (HTML, JSON, agent-prompt Markdown). Pure TypeScript source, no build: the worker, the CLI and the tests
import `src/index.ts` directly.

## Report CLI

Cross-checked report models for domains, one JSON line per domain. Read-only: public DNS-over-HTTPS lookups only,
no secrets, nothing published.

Requirements: Node `^22.22.2 || ^24.15.0` (type stripping and `module.registerHooks`), and `npm ci` at the repo root
so `@inbox-angel/dns-checks` and `tldts` resolve from its `node_modules`. `loader.mjs` maps extensionless relative
imports to their `.ts` files. Run from the repo root:

```sh
node --import ./packages/report/loader.mjs packages/report/cli.ts example.com other.io > reports.jsonl
node --import ./packages/report/loader.mjs packages/report/cli.ts --in domains.txt \
  --tokens '{"example.com":"<token>"}' --blocks blocks.json --concurrency 2
```

| Option | Meaning |
|---|---|
| `<domain>...`, `--in <file>` | Domains, as arguments or whitespace-separated in a file. URLs, paths, ports and case are normalized to the registrable domain (`https://WWW.Example.com/x` -> `example.com`); duplicates run once. |
| `--tokens <json>` | `{"domain": "token"}`. A domain's `reportUrl` is `<report-url-base><token>`; a domain without a token gets `reportUrl: null`. The CLI never generates tokens. |
| `--report-url-base <url>` | Default `https://inboxangel.io/r/`. |
| `--blocks <file>` | JSON `{"domain": [{"id", "html"}]}`: trusted caller HTML (an offer, a DMARC-vendor note) inserted into that domain's HTML report after the fixes. The Markdown agent prompt never carries caller blocks. |
| `--concurrency <n>` | Domains checked at once. Default 4. |

Per domain the CLI runs `checkDomain()` once per resolver in `DOH_ENDPOINTS` (Cloudflare, Google, NextDNS; each run
includes the NS lookup that gives the DNS host), then `buildReport()`. Each output line is one of:

- `{"schema", "domain", "model", "html", "md"}`: the JSON rendering is `model` itself. Failed lookups are not errors:
  they stay in the model (`lookupFailed`, `grade.level: null`); a failed lookup never confirms a finding.
- `{"schema", "domain", "error"}`: the domain could not be reported (for example, not a registrable domain).

Lines appear in completion order. One domain never aborts the batch. Exit code 0 after every domain has a line,
2 on a usage error before any lookup. Callers must refuse a `schema` they do not know.
