import { Button, LevelLadder, Skeleton, StatusLabel, cn } from '@inbox-angel/ui';
import { RefreshCw } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import type { DomainVerdict } from '../../lib/verdict';

/**
 * Slot for one contextual "Talk to Max" link (verdict.help): renders nothing until the help link component exists.
 * PR 142 replaces the body with `<TalkToMax lead={help.lead} about={help.about} />`, which itself renders nothing
 * unless a help URL is configured.
 */
export function ContextHelp(_props: { help: NonNullable<DomainVerdict['help']> }) {
	return null;
}

const AREAS = 'grid gap-x-6 gap-y-3 [grid-template-areas:"head"_"ladder"_"body"] lg:grid-cols-[22rem_minmax(0,1fr)] lg:[grid-template-areas:"ladder_head"_"ladder_body"]';

/**
 * One domain on the overview: the name and its state, the level ladder, what is true now with its evidence, when it
 * was checked, and the one next action with who acts. `verdict` is null while it loads.
 */
export function DomainRow({
	domain,
	parent,
	verdict,
	canWrite,
	onRetry,
}: {
	domain: { id: number; domain: string };
	/** Set for a subdomain listed under its parent. */
	parent?: string;
	verdict: DomainVerdict | null;
	canWrite: boolean;
	onRetry?: () => void;
}) {
	const nameId = useId();
	const page = `/domains/${domain.id}`;

	if (!verdict) {
		return (
			<li aria-labelledby={nameId} aria-busy="true" className={cn('px-4 py-4 sm:px-5', parent && 'sm:pl-10')}>
				<div className={AREAS}>
					<h3 id={nameId} className="font-mono text-base font-semibold [grid-area:head] [overflow-wrap:anywhere]">
						{domain.domain}
					</h3>
					<Skeleton className="h-8 w-full [grid-area:ladder]" />
					<div className="space-y-2 [grid-area:body]">
						<Skeleton className="h-4 w-3/4" />
						<span className="text-sm text-ink-2">Checking what is known…</span>
					</div>
				</div>
			</li>
		);
	}

	const { next } = verdict;
	// Read-only members are not sent into wizards that change things: they get the domain page instead.
	const writes = !!next.to && /\/(setup|dmarc-wizard|spf-flatten|settings)/.test(next.to);
	const to = next.to && (canWrite || !writes) ? next.to : next.to ? page : undefined;
	const nothing = next.who === 'Nobody';

	return (
		<li aria-labelledby={nameId} data-status={verdict.status} className={cn('px-4 py-4 sm:px-5', parent && 'sm:pl-10')}>
			<div className={AREAS}>
				<div className="min-w-0 space-y-0.5 [grid-area:head]">
					<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<h3 id={nameId} className="min-w-0 font-mono text-base font-semibold [overflow-wrap:anywhere]">
							<Link to={page} className="rounded-sm underline-offset-4 hover:underline">
								{domain.domain}
							</Link>
						</h3>
						<StatusLabel kind={verdict.status} />
					</div>
					{parent ? <p className="text-xs text-ink-2">Subdomain of {parent}</p> : null}
				</div>
				<LevelLadder level={verdict.level} className="self-start [grid-area:ladder] lg:pt-1" aria-label={`${domain.domain}: protection level`} />
				<div className="min-w-0 space-y-1.5 [grid-area:body]">
					<p className="max-w-prose text-sm text-ink-1">{verdict.sentence}</p>
					{verdict.evidence ? <p className="max-w-prose text-sm text-ink-2">{verdict.evidence}</p> : null}
					{verdict.checked ? <p className="text-xs text-ink-2">{verdict.checked}</p> : null}
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-sm">
						{nothing ? (
							<span className="text-ink-2">Next: nothing to do.</span>
						) : (
							<>
								<span className="text-ink-2">
									Next, <span className="font-medium text-ink-1">{next.who.charAt(0).toLowerCase() + next.who.slice(1)}:</span>
								</span>
								{onRetry && !next.to ? (
									<Button variant="secondary" size="sm" onClick={onRetry}>
										<RefreshCw aria-hidden />
										{next.label}
									</Button>
								) : to ? (
									<Link to={to} aria-label={`${next.label} for ${domain.domain}`} className="rounded-sm font-medium text-brand-ink underline underline-offset-4">
										{next.label}
									</Link>
								) : (
									<span className="font-medium text-ink-1">{next.label}</span>
								)}
							</>
						)}
					</div>
					{verdict.help ? <ContextHelp help={verdict.help} /> : null}
				</div>
			</div>
		</li>
	);
}
