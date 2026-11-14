import { Alert } from '@ready-set-mail/ui';
import { ApiError } from '../lib/api';
import { HELP_PRIORITY, TalkToMax } from './TalkToMax';

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

const MORE = { domains_per_workspace: 'Managing more domains?', workspaces_per_user: 'Need more workspaces?' } as const;
const ABOUT = { domains_per_workspace: 'about your domains', workspaces_per_user: 'about your workspaces' } as const;
const FREE_UP = {
	domains_per_workspace: 'Remove a domain you no longer need to add another.',
	workspaces_per_user: 'Delete a workspace you no longer use to make room for a new one.',
} as const;

/** A plan limit is information, not a failure: the person did nothing wrong. */
export function PlanLimitNotice({ limit, className }: { limit: PlanLimit; className?: string }) {
	// The response's link (https only; the server builds it with the same helpUrl()) becomes the shared Talk to Max line,
	// the one contextual link on the screen. Without one, say how to make room.
	const href = limit.help_url?.startsWith('https://') ? limit.help_url : null;
	return (
		<Alert variant="info" className={className}>
			<p>{limit.message}</p>
			{href ? <TalkToMax href={href} priority={HELP_PRIORITY.planLimit} lead={MORE[limit.kind]} about={ABOUT[limit.kind]} /> : <p>{FREE_UP[limit.kind]}</p>}
		</Alert>
	);
}
