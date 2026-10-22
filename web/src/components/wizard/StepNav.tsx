import { Button } from '@inbox-angel/ui';
import type { ReactNode } from 'react';

/** Back/skip on the start side, the primary action on the end side; stacks (primary first) on phones. */
export function StepFooter({ start, end }: { start?: ReactNode; end?: ReactNode }) {
	return (
		<div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex flex-col gap-2 sm:flex-row">{start}</div>
			<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">{end}</div>
		</div>
	);
}

/** Continue / Skip for now. Navigation is open to members too: only the actions inside a step write. */
export function StepNav({
	onNext,
	onSkip,
	onBack,
	nextLabel = 'Continue',
	showSkip = true,
	busy = false,
}: {
	onNext: () => void;
	onSkip?: () => void;
	onBack?: () => void;
	nextLabel?: string;
	showSkip?: boolean;
	busy?: boolean;
}) {
	return (
		<StepFooter
			start={
				<>
					{onBack ? (
						<Button variant="ghost" onClick={onBack}>
							Back
						</Button>
					) : null}
					{showSkip && onSkip ? (
						<Button variant="ghost" onClick={onSkip} disabled={busy}>
							Skip for now
						</Button>
					) : null}
				</>
			}
			end={
				<Button onClick={onNext} disabled={busy}>
					{nextLabel}
				</Button>
			}
		/>
	);
}
