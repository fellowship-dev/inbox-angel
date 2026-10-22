import { Button } from '@inbox-angel/ui';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

/** Top of the single-purpose wizards: way back, title, one-line purpose. */
export function WizardHeader({ backTo, backLabel = 'Back to domain', title, subtitle }: { backTo: string; backLabel?: string; title: ReactNode; subtitle?: ReactNode }) {
	return (
		<header className="space-y-2">
			<Button asChild variant="ghost" size="sm" className="-ml-3">
				<Link to={backTo}>
					<ArrowLeft aria-hidden />
					{backLabel}
				</Link>
			</Button>
			<h1 className="text-2xl font-bold tracking-tight">{title}</h1>
			{subtitle ? <p className="text-sm text-ink-2">{subtitle}</p> : null}
		</header>
	);
}
