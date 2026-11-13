import { Alert, Button, Card, CardContent, PageHeader, Skeleton, toast } from '@inbox-angel/ui';
import { Check, Copy, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { LoadError, Section } from '../../components/states';
import { FIRST_PROMPT, useAgentStatus, usePreflight } from '../../lib/instance';

async function copy(value: string, what: string) {
	try {
		await navigator.clipboard.writeText(value);
		toast({ title: `${what} copied`, variant: 'success', duration: 2000 });
	} catch {
		toast({ title: 'Could not copy', description: 'Your browser blocked the clipboard. Select the text and copy it instead.', variant: 'warning' });
	}
}

const CAN = [
	'Tell you which of your domains need attention, and why.',
	"Read each domain's email health report: what DNS shows, the reports received, and what is still missing.",
	'Run a live DNS check on a domain.',
	'Suggest the exact DNS changes that would fix a problem, for you to make.',
	'Add a domain and check its ownership record, if you allow that.',
];

const NEVER = [
	'Change your DNS records',
	'Tighten your DMARC policy to quarantine or reject',
	'Send email or invite people',
	'Give itself more access, or use domains you did not choose',
];

export function AgentSetupPage() {
	const status = useAgentStatus();
	return (
		<div className="space-y-8">
			<PageHeader
				title="Agents"
				description="Let an AI assistant such as Claude or ChatGPT look at your domains and explain what to fix. You choose which domains it sees and for how long."
			/>
			{status.isPending ? (
				<Skeleton className="h-40 w-full" />
			) : status.isError ? (
				<LoadError error={status.error} onRetry={() => void status.refetch()} title="Could not check whether agents can connect" />
			) : status.data.available && status.data.server_url ? (
				<Ready serverUrl={status.data.server_url} />
			) : (
				<NotReady />
			)}
		</div>
	);
}

function NotReady() {
	const { owner, query } = usePreflight();
	const missing = query.data?.items.filter((i) => i.id === 'oauth_storage' || i.id === 'auth_url') ?? [];
	if (!owner) {
		return (
			<Alert variant="info" title="Agents can't connect to this instance yet">
				The person who runs this instance has not finished its agent setup. Ask them to; this page will then show how to connect.
			</Alert>
		);
	}
	return (
		<Alert variant="warning" title="Agents can't connect to this instance yet">
			<p>Two settings are needed where the Worker is deployed: an OAUTH_KV namespace that only this instance uses, and BETTER_AUTH_URL set to this dashboard's HTTPS address.</p>
			{missing.length ? (
				<ul className="mt-2 list-disc space-y-1 pl-5">
					{missing.map((i) => (
						<li key={`${i.id}-${i.severity}`} className="break-words">
							{i.message}
						</li>
					))}
				</ul>
			) : null}
			<p className="mt-2">
				The steps are in{' '}
				<a href="https://github.com/fellowship-dev/inbox-angel/blob/main/docs/agent-operations.md#installer-setup" target="_blank" rel="noreferrer">
					the operator guide
				</a>
				.
			</p>
		</Alert>
	);
}

function Ready({ serverUrl }: { serverUrl: string }) {
	return (
		<>
			<Section title="What an agent can do here">
				<Card>
					<CardContent className="p-5 sm:p-6">
						<ul className="space-y-2 text-sm">
							{CAN.map((line) => (
								<li key={line} className="flex gap-2">
									<Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
									<span>{line}</span>
								</li>
							))}
						</ul>
						<p className="mt-4 text-sm text-ink-2">Only for the domains and permissions you approve, and only until the date you pick (1 to 30 days).</p>
					</CardContent>
				</Card>
			</Section>

			<Section title="Connect your assistant">
				<Card>
					<CardContent className="space-y-6 p-5 sm:p-6">
						<Step n={1} title="Add this server URL to your assistant">
							<p className="text-sm text-ink-2">In Claude or ChatGPT, add a custom connector (it may be called an MCP server) and paste this address.</p>
							<div className="flex flex-wrap items-center gap-2">
								<code className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm">{serverUrl}</code>
								<Button variant="secondary" onClick={() => void copy(serverUrl, 'Server URL')}>
									<Copy aria-hidden />
									Copy URL
								</Button>
							</div>
						</Step>
						<Step n={2} title="Approve what it may do">
							<p className="text-sm text-ink-2">
								Your assistant opens a page from this dashboard. Sign in if asked, tick the domains it may use and what it may do, and pick when access ends. Nothing is shared until you choose Allow access.
							</p>
						</Step>
						<Step n={3} title="Ask your first question">
							<p className="text-sm text-ink-2">Paste this into a new chat. It asks for advice only and changes nothing.</p>
							<p className="whitespace-pre-wrap rounded-md border border-line bg-surface-2 px-3 py-2 text-sm" id="first-prompt">
								{FIRST_PROMPT}
							</p>
							<Button variant="secondary" aria-describedby="first-prompt" onClick={() => void copy(FIRST_PROMPT, 'Prompt')}>
								<Copy aria-hidden />
								Copy prompt
							</Button>
						</Step>
					</CardContent>
				</Card>
			</Section>

			<Section title="See and revoke connections">
				<Card>
					<CardContent className="space-y-3 p-5 sm:p-6">
						<p className="text-sm">
							Every agent you approve is listed in Settings, under Agents and product access, with when it was created, when it was last used and when it ends. Revoke one there and its next request is refused.
						</p>
						<Button asChild variant="secondary">
							<Link to="/settings">Open your connections</Link>
						</Button>
					</CardContent>
				</Card>
			</Section>

			<Section title="What an agent can never do here">
				<Card>
					<CardContent className="p-5 sm:p-6">
						<ul className="space-y-2 text-sm">
							{NEVER.map((line) => (
								<li key={line} className="flex gap-2">
									<X aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
									<span>{line}</span>
								</li>
							))}
						</ul>
						<p className="mt-4 text-sm text-ink-2">An agent can suggest these changes. You make them yourself, in the dashboard or at your DNS provider.</p>
					</CardContent>
				</Card>
			</Section>
		</>
	);
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
	return (
		<div className="flex gap-3">
			<span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-sm font-semibold text-brand-ink">
				{n}
			</span>
			<div className="min-w-0 flex-1 space-y-2">
				<h3 className="font-semibold">
					<span className="sr-only">Step {n}: </span>
					{title}
				</h3>
				{children}
			</div>
		</div>
	);
}
