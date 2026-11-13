import { Alert } from '@inbox-angel/ui';
import { ApiError } from '../lib/api';

export interface PlanLimit {
	kind: 'workspaces_per_user' | 'domains_per_workspace';
	/** The server's sentence, shown as is. */
	message: string;
	/** Where to ask for more; only ever used as a link when it is https. */
	help_url: string | null;
}

/** The plan limit an API error carries (HTTP 403, code `plan_limit`), or null for any other error. */
export function planLimitOf(err: unknown): PlanLimit | null {
	if (!(err instanceof ApiError)) return null;
	const body = err.body as { code?: unknown; limit?: { kind?: unknown }; help_url?: unknown } | undefined;
	if (body?.code !== 'plan_limit') return null;
	return {
		kind: body.limit?.kind === 'workspaces_per_user' ? 'workspaces_per_user' : 'domains_per_workspace',
		message: err.message,
		help_url: typeof body.help_url === 'string' ? body.help_url : null,
	};
}

const MORE = { domains_per_workspace: 'Managing more domains? ', workspaces_per_user: 'Need more workspaces? ' } as const;
const FREE_UP = {
	domains_per_workspace: 'Remove a domain you no longer need to add another.',
	workspaces_per_user: 'Delete a workspace you no longer use to make room for a new one.',
} as const;

/** A plan limit is information, not a failure: the person did nothing wrong. */
export function PlanLimitNotice({ limit, className }: { limit: PlanLimit; className?: string }) {
	// Re-checked here: only an https URL ever becomes a link.
	const href = limit.help_url?.startsWith('https://') ? limit.help_url : null;
	return (
		<Alert variant="info" className={className}>
			<p>{limit.message}</p>
			{href ? (
				<p>
					{MORE[limit.kind]}
					{/* TODO: use the shared TalkToMax component once the help-link PR lands. */}
					<a href={href} target="_blank" rel="noopener noreferrer">
						Talk to Max
					</a>
				</p>
			) : (
				<p>{FREE_UP[limit.kind]}</p>
			)}
		</Alert>
	);
}
