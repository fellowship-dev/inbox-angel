/** Wording for a domain whose every name under `_domainkey` answers with the same TXT record (the API's `wildcard: true`). */
export const DKIM_WILDCARD_LABEL = "Can't tell from public DNS";

export const dkimWildcardSummary = (domain: string): string =>
	`Every name under ${domain} answers with the same TXT record, so public DNS can't show which DKIM keys exist.`;
