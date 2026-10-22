import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Domain } from './types';

export const keys = {
	domains: ['domains'] as const,
	domain: (id: number) => ['domain', id] as const,
};

export function useDomains() {
	return useQuery({ queryKey: keys.domains, queryFn: () => api<{ domains: Domain[] }>('/api/domains').then((r) => r.domains) });
}

/** One domain from the list (there is no GET /api/domains/:id). `domain` is undefined while loading or if it does not exist. */
export function useDomain(id: number) {
	const q = useDomains();
	return { ...q, domain: q.data?.find((d) => d.id === id) };
}
