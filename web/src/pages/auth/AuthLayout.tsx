import { Card, CardContent, LogoMark } from '@inbox-angel/ui';
import type { ReactNode } from 'react';

export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-surface-0 px-4 py-10 text-ink-1">
			<div className="w-full max-w-md space-y-6">
				<div className="flex items-center justify-center gap-2 text-lg font-bold tracking-tight">
					<LogoMark className="size-8" aria-hidden />
					Inbox Angel
				</div>
				<Card>
					<CardContent className="space-y-5 p-6">
						<div className="space-y-1.5">
							<h1 className="text-2xl font-bold tracking-tight">{title}</h1>
							{description ? <p className="text-sm text-ink-2">{description}</p> : null}
						</div>
						{children}
					</CardContent>
				</Card>
			</div>
		</main>
	);
}

/** Label + control + hint/error wired together. */
export function Field({ id, label, hint, children }: { id: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
	return (
		<div className="space-y-1.5">
			<label htmlFor={id} className="text-sm font-medium leading-none text-ink-1">
				{label}
			</label>
			{children}
			{hint ? (
				<p id={`${id}-hint`} className="text-sm text-ink-2">
					{hint}
				</p>
			) : null}
		</div>
	);
}
