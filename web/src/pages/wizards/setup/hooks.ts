import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import type { OnboardingStatus, WizardState } from '../../../lib/types';
import { DEFAULT_WIZARD } from './steps';

export const setupKeys = {
	status: (id: number) => ['onboarding-status', id] as const,
	wizard: (id: number) => ['wizard-state', id] as const,
};

/** Live DNS state for the wizard. Always refetched on mount: it reflects what the resolvers say right now. */
export function useOnboardingStatus(domainId: number) {
	return useQuery({
		queryKey: setupKeys.status(domainId),
		queryFn: () => api<OnboardingStatus>(`/api/domains/${domainId}/onboarding-status`),
		staleTime: 0,
	});
}

/** Persisted step outcomes. If it cannot be read the wizard still works: everything counts as not started. */
export function useWizardState(domainId: number) {
	return useQuery({
		queryKey: setupKeys.wizard(domainId),
		queryFn: () => api<WizardState>(`/api/domains/${domainId}/wizard-state`).catch(() => DEFAULT_WIZARD),
		staleTime: 0,
	});
}


/** `value` after it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return debounced;
}
