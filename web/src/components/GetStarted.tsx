import { Button, StatusLabel, cn } from '@ready-set-mail/ui';
import { useId } from 'react';
import { Link } from 'react-router';

/**
 * The few real steps from an empty workspace to a first answer, each in the state the data shows. No step is ticked
 * by visiting a page or by guessing; the list disappears once every step is done.
 *
 * - `done`: the data shows it.
 * - `todo`: not yet; the first one carries the action.
 * - `waiting`: nothing for a person to do (reports on their way).
 * - `unknown`: the data that would settle it is still loading or failed.
 */
export type StepState = 'done' | 'todo' | 'waiting' | 'unknown';

export interface Step {
	key: string;
	title: string;
	state: StepState;
	/** The current fact, in one sentence. */
	detail: string;
	action?: { label: string; to: string };
}

const WORD: Record<Exclude<StepState, 'todo'>, { kind: 'verified' | 'gathering' | 'unknown'; label: string }> = {
	done: { kind: 'verified', label: 'Done' },
	waiting: { kind: 'gathering', label: 'Waiting' },
	unknown: { kind: 'unknown', label: 'Unknown' },
};

export function GetStarted({ steps }: { steps: Step[] }) {
	const headingId = useId();
	if (steps.length === 0 || steps.every((s) => s.state === 'done')) return null;
	const done = steps.filter((s) => s.state === 'done').length;
	const current = steps.findIndex((s) => s.state === 'todo');
	return (
		<section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface-1">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3 sm:px-5">
				<h2 id={headingId} className="text-base font-semibold tracking-tight">
					Get to your first answer
				</h2>
				<p className="text-sm text-ink-2">
					{done} of {steps.length} done
				</p>
			</div>
			<ol className="divide-y divide-line">
				{steps.map((s, i) => {
					const isCurrent = i === current;
					return (
						<li key={s.key} data-state={s.state} className="flex gap-3 px-4 py-3 sm:px-5" aria-current={isCurrent ? 'step' : undefined}>
							<span
								aria-hidden
								className={cn(
									'mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 font-mono text-xs font-semibold',
									isCurrent ? 'bg-accent text-accent-fg' : 'border border-line-strong text-ink-2',
								)}
							>
								{i + 1}
							</span>
							<div className="min-w-0 flex-1 space-y-1">
								<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
									<p className={cn('text-sm font-semibold', s.state === 'done' ? 'text-ink-2' : 'text-ink-1')}>{s.title}</p>
									{s.state === 'todo' ? <span className="text-sm text-ink-2">To do</span> : <StatusLabel kind={WORD[s.state].kind} label={WORD[s.state].label} />}
								</div>
								<p className="max-w-prose text-sm text-ink-2">{s.detail}</p>
								{isCurrent && s.action ? (
									<Button asChild size="sm" className="mt-1.5">
										<Link to={s.action.to}>{s.action.label}</Link>
									</Button>
								) : null}
							</div>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
