/**
 * One quiet line on the installer-proof screen of a self-hosted installation, shown only when the operator set
 * HOSTED_SERVICE_URL (the server sends it as `hosted_service_url`). Without it, nothing renders: never a dead
 * link, never a banner, and setting up this installation is never blocked or delayed.
 */
export function HostedAlternative({ url }: { url?: string | null }) {
	if (!url || !/^https:\/\//i.test(url)) return null;
	return (
		<p className="text-center text-sm text-ink-2">
			Only need to monitor your domains, without running your own installation?{' '}
			<a href={url} target="_blank" rel="noopener noreferrer" className="text-brand-ink underline underline-offset-4">
				The hosted free tier
			</a>{' '}
			is the fastest way to start monitoring a domain; a self-hosted installation keeps every feature.
		</p>
	);
}
