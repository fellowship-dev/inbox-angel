import { Button, LevelLadder, Skeleton, StatusLabel, cn } from '@ready-set-mail/ui';
import { RefreshCw } from 'lucide-react';
import { useId } from 'react';
import { Link } from 'react-router';
import type { DomainVerdict } from '../../lib/verdict';
import { TalkToMax } from '../TalkToMax';

/**
 * One contextual "Talk to Max" line where a person may be stuck (verdict.help). TalkToMax renders nothing without a
 * booking link, and within one screen's scope only the most specific line shows.
 */
export function ContextHelp({ help }: { help: NonNullable<DomainVerdict['help']> }) {
	return <TalkToMax priority={help.priority} lead={help.lead} about={help.about} />;
}

const INDENT = ['', 'sm:pl-10', 'sm:pl-16', 'sm:pl-20'] as const;
const indent = (depth: number) => INDENT[Math.min(depth, INDENT.length - 1)];

const AREAS = 'grid gap-x-6 gap-y-3 [grid-template-areas:"head"_"ladder"_"body"] lg:grid-cols-[22rem_minmax(0,1fr)] lg:[grid-template-areas:"ladder_head"_"ladder_body"]';

/**
 * One domain on the overview: the name and its state, the level ladder, what is true now with its evidence, when it
 * was checked, and the one next action with who acts. `verdict` is null while it loads.
 */
export function DomainRow({
	domain,
	parent,
	depth = parent ? 1 : 0,
	verdict,
	canWrite,
	onRetry,
	hideEvidence = false,
}: {
	domain: { id: number; domain: string };
	/** Set for a subdomain listed under its parent. */
	parent?: string;
	/** Nesting depth under the nearest listed ancestor (0: a root). */
	depth?: number;
	verdict: DomainVerdict | null;
	canWrite: boolean;
	onRetry?: () => void;
	/** Hosted before report intake: the overview says once that reports are not connected, so rows make no report claim. */
	hideEvidence?: boolean;
}) {
	const nameId = useId();
	const page = `/domains/${domain.id}`;

	if (!verdict) {
		return (
			<li aria-labelledby={nameId} aria-busy="true" className={cn('px-4 py-4 sm:px-5', indent(depth))}>
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
		<li aria-labelledby={nameId} data-status={verdict.status} className={cn('px-4 py-4 sm:px-5', indent(depth))}>
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
					{verdict.evidence && !hideEvidence ? <p className="max-w-prose text-sm text-ink-2">{verdict.evidence}</p> : null}
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
