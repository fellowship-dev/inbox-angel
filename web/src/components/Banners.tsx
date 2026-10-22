import { Alert, IconButton } from '@inbox-angel/ui';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

const DISMISS_KEY = 'ia_update_dismissed';

interface VersionInfo {
	current: string;
	latest: string | null;
	update_available: boolean;
	release_url: string;
}

/** "New version available" and "your dashboard is also at <custom domain>". Both are advisory: failures stay silent. */
export function Banners() {
	const { status } = useSession();
	const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1');
	const version = useQuery({ queryKey: ['version'], queryFn: () => api<VersionInfo>('/api/version'), staleTime: 3_600_000, retry: false });
	const custom = status?.custom_domain && window.location.hostname !== status.custom_domain ? status.custom_domain : null;
	const update = version.data?.update_available && !dismissed ? version.data : null;

	if (!update && !custom) return null;
	return (
		<div className="space-y-3">
			{custom ? (
				<Alert variant="info" title="Your dashboard has its own address">
					It is also available at{' '}
					<a href={`https://${custom}`} className="font-semibold">
						{custom}
					</a>
					.
				</Alert>
			) : null}
			{update ? (
				<Alert variant="info" title={`New version available: v${update.latest}`}>
					<div className="flex items-start justify-between gap-3">
						<span>
							You are on v{update.current}.{' '}
							<a href={update.release_url} target="_blank" rel="noreferrer">
								View release
							</a>
						</span>
						<IconButton
							label="Dismiss update notice"
							size="sm"
							onClick={() => {
								sessionStorage.setItem(DISMISS_KEY, '1');
								setDismissed(true);
							}}
						>
							<X aria-hidden />
						</IconButton>
					</div>
				</Alert>
			) : null}
		</div>
	);
}
