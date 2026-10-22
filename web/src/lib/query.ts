import { MutationCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export function createQueryClient(): QueryClient {
	const client: QueryClient = new QueryClient({
		// Any successful write can change "does this instance have a domain yet" (the setup redirect reads it).
		// The cache awaits this before the mutation's own onSuccess, so callers navigate on fresh status.
		mutationCache: new MutationCache({ onSuccess: () => client.invalidateQueries({ queryKey: ['auth-status'] }) }),
		defaultOptions: {
			queries: {
				staleTime: 15_000,
				refetchOnWindowFocus: false,
				// 4xx are answers, not blips: retrying them only delays the error state.
				retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
			},
		},
	});
	return client;
}
