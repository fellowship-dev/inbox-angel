import { IconButton, LogoMark } from '@inbox-angel/ui';
import { Moon, Sun, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTheme } from '../lib/theme';

/** Full-screen chrome for wizards: no sidebar, a way out, room to focus. */
export function FocusLayout({ children, exitTo = '/', exitLabel = 'Exit' }: { children: ReactNode; exitTo?: string; exitLabel?: string }) {
	const { theme, toggle } = useTheme();
	return (
		<div className="min-h-screen bg-surface-0 text-ink-1">
			<header className="flex h-16 items-center justify-between border-b border-line bg-surface-1 px-4 sm:px-6">
				<Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
					<LogoMark className="size-7" aria-hidden />
					Inbox Angel
				</Link>
				<div className="flex items-center gap-2">
					<IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
						{theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
					</IconButton>
					<Link to={exitTo} className="inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink-1">
						<X aria-hidden className="size-4" />
						{exitLabel}
					</Link>
				</div>
			</header>
			<main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
				{children}
			</main>
		</div>
	);
}
