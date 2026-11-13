import { Alert } from '@inbox-angel/ui';
import { usePreflight } from '../lib/instance';
import type { PreflightItem } from '../lib/types';

function Items({ items }: { items: PreflightItem[] }) {
	return (
		<ul className="mt-1 space-y-2">
			{items.map((i) => (
				<li key={`${i.id}-${i.setting}`} className="min-w-0 break-words">
					{i.message} <span className="font-mono text-xs text-ink-2">({i.setting})</span>
				</li>
			))}
		</ul>
	);
}

/**
 * The instance configuration check, for the person who runs the instance and nobody else.
 * `compact`: the banner on every page, shown only while something needs action.
 */
export function SetupCheck({ compact = false }: { compact?: boolean }) {
	const { owner, query } = usePreflight();
	if (!owner || !query.data) return null;
	const actions = query.data.items.filter((i) => i.severity === 'action');
	const notes = query.data.items.filter((i) => i.severity === 'note');
	if (compact) {
		if (!actions.length) return null;
		return (
			<Alert variant="warning" role="status" title={actions.length === 1 ? 'One setting needs your attention' : `${actions.length} settings need your attention`}>
				<p>Only you see this, because you run this instance (on the hosted service, the verified account in OWNER_EMAIL). Settings are changed where the Worker is deployed; none of their values are shown here.</p>
				<Items items={actions} />
			</Alert>
		);
	}
	const who = <p className="text-sm text-ink-2">Setup check. Only the person who runs this instance sees it; on the hosted service, that is the verified account in OWNER_EMAIL.</p>;
	if (!actions.length && !notes.length) {
		return (
			<div className="space-y-3">
				{who}
				<Alert variant="success" title="Nothing to fix">
					Checked: mode, dashboard address, agent storage, mail sender, bot check, rate limits and booking link.
				</Alert>
			</div>
		);
	}
	return (
		<div className="space-y-3">
			{who}
			{actions.length ? (
				<Alert variant="warning" title="Needs your attention">
					<Items items={actions} />
				</Alert>
			) : null}
			{notes.length ? (
				<Alert variant="info" title="Worth knowing">
					<Items items={notes} />
				</Alert>
			) : null}
		</div>
	);
}
