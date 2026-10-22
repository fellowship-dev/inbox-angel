import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export function createQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 15_000,
				refetchOnWindowFocus: false,
				// 4xx are answers, not blips: retrying them only delays the error state.
				retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
			},
		},
	});
}
