import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router';

/** Eyebrow link above a page title. */
export function BackLink({ to, children }: { to: string; children: string }) {
	return (
		<Link to={to} className="inline-flex items-center gap-1 rounded-sm text-ink-2 underline-offset-4 hover:text-ink-1 hover:underline">
			<ArrowLeft aria-hidden className="size-4" />
			{children}
		</Link>
	);
}
