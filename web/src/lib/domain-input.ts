/**
 * A domain typed or carried in from outside (a link, the website), made safe to show and to send: the hostname in lower-case ASCII
 * (IDN as punycode), or null. The rule is the server's, from one shared module (`@ready-set-mail/dns-checks/domain-name`), so a name the
 * dashboard accepts is a name the API accepts. Special-use names (`printer.local`, `site.test`) are refused here too.
 */
import { normalizeDomainName } from '@ready-set-mail/dns-checks/domain-name';

export function normalizeDomainInput(raw: string): string | null {
	const n = normalizeDomainName(raw);
	return n.ok ? n.domain : null;
}
