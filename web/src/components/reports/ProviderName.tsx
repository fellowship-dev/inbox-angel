import { providerName, serviceVia, type AuthSource } from '../../lib/reports';

/** Who sent it: the provider (or the bare IP), the IP underneath, and the authenticating service when it differs. */
export function ProviderName({ src, showVia = true }: { src: AuthSource; showVia?: boolean }) {
	const name = providerName(src);
	const via = showVia ? serviceVia(src) : null;
	return (
		<span className="flex min-w-0 flex-col">
			{name ? <span className="font-semibold text-ink-1 [overflow-wrap:anywhere]">{name}</span> : null}
			<code className={name ? 'font-mono text-xs text-ink-2' : 'font-mono text-sm text-ink-1'}>{src.source_ip}</code>
			{via ? <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">via {via}</span> : null}
		</span>
	);
}
