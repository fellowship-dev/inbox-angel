import { Card, CardContent } from '@inbox-angel/ui';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/** The card every wizard step lives in. The heading takes focus on mount so a step change is announced. */
export function StepCard({ title, badge, children, focusHeading = true }: { title: ReactNode; badge?: ReactNode; children: ReactNode; focusHeading?: boolean }) {
	const id = useId();
	const ref = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (focusHeading) ref.current?.focus({ preventScroll: true });
	}, [focusHeading]);
	return (
		<Card role="region" aria-labelledby={id}>
			<CardContent className="space-y-4 sm:p-6">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					{badge}
					<h2 id={id} ref={ref} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
						{title}
					</h2>
				</div>
				{children}
			</CardContent>
		</Card>
	);
}
