// Shape of the fix catalog. Keys stay as in the Z JSON catalog (snake_case), so content ports verbatim.

export interface CatalogRecord {
  /** Template; `{domain}` and derived values are filled per domain. */
  name: string;
  type: string;
  value: string;
  note: string;
}

export interface CatalogEntry {
  /** A dns-checks provider id (`providers.ts`), or `*`. */
  provider: string;
  /** A dns-checks DNS host id (`dns-hosts.ts`), or `*`. */
  dns_host: string;
  /** Optional condition: a derived flag name, or `!name`. */
  when?: string;
  exact: boolean;
  title: string;
  why: string;
  records: CatalogRecord[];
  /** `@dns_host` expands to the DNS host's steps for each record. */
  steps: string[];
  sources: string[];
  caveat?: string | null;
  optional_next?: string;
  needs_from_provider?: string[];
  /** provider id -> hint, shown when that provider is detected. */
  provider_hints?: Record<string, string>;
}

export interface CatalogFile {
  finding: string;
  entries: CatalogEntry[];
}

export type HostStep = string | { types: string[]; text: string };

export interface DnsHostSteps {
  label: string;
  steps: HostStep[];
  sources: string[];
}

export interface DnsHostCatalog {
  note: string;
  hosts: { cloudflare: DnsHostSteps; generic: DnsHostSteps };
}
