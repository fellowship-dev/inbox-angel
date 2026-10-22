import { cn } from '@inbox-angel/ui';
import { Check, SkipForward } from 'lucide-react';

export interface ProgressStep {
	label: string;
	/** Persisted outcome of the step, if it has one. */
	state?: 'complete' | 'skipped' | 'pending';
}

/**
 * "Step 2 of 5" in words, plus one marker per step. The current step carries aria-current="step";
 * complete and skipped steps get an icon and a screen-reader word, so colour is never the only signal.
 */
export function WizardProgress({ steps, current, label = 'Progress' }: { steps: ProgressStep[]; current: number; label?: string }) {
	return (
		<nav aria-label={label} className="space-y-2">
			<p className="text-sm font-medium text-ink-2">
				Step {current + 1} of {steps.length}
				<span className="text-ink-1">: {steps[current]?.label}</span>
			</p>
			<ol className="flex gap-1.5">
				{steps.map((s, i) => {
					const isCurrent = i === current;
					return (
						<li key={s.label} aria-current={isCurrent ? 'step' : undefined} className="min-w-0 flex-1 space-y-1">
							<div
								aria-hidden
								className={cn(
									'h-1.5 rounded-full',
									s.state === 'complete' ? 'bg-success' : s.state === 'skipped' ? 'bg-warning' : isCurrent ? 'bg-brand' : 'bg-line-strong',
								)}
							/>
							<span className={cn('flex items-center gap-1 text-xs', isCurrent ? 'font-semibold text-ink-1' : 'text-ink-2')}>
								{s.state === 'complete' ? <Check aria-hidden className="size-3 shrink-0 text-success" /> : null}
								{s.state === 'skipped' ? <SkipForward aria-hidden className="size-3 shrink-0 text-warning" /> : null}
								<span className="truncate">{s.label}</span>
								{s.state === 'complete' ? <span className="sr-only">(complete)</span> : null}
								{s.state === 'skipped' ? <span className="sr-only">(skipped)</span> : null}
								{isCurrent ? <span className="sr-only">(current step)</span> : null}
							</span>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}
