import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'ia_theme';
const listeners = new Set<() => void>();

function systemTheme(): Theme {
	return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function current(): Theme {
	const attr = document.documentElement.dataset.theme;
	return attr === 'light' || attr === 'dark' ? attr : systemTheme();
}

export function setTheme(theme: Theme): void {
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(KEY, theme);
	} catch {
		/* private mode: the choice just doesn't persist */
	}
	listeners.forEach((l) => l());
}

export function useTheme(): { theme: Theme; toggle: () => void } {
	const theme = useSyncExternalStore(
		(cb) => (listeners.add(cb), () => void listeners.delete(cb)),
		current,
		() => 'light' as Theme,
	);
	const toggle = useCallback(() => setTheme(current() === 'dark' ? 'light' : 'dark'), []);
	return { theme, toggle };
}
