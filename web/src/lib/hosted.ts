import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { domainKeys, invalidateDomain } from './domain-queries';

/** Hosted records (docs/hosted.md, API section). All of it is dormant unless GET /api/hosted/config says enabled. */
export type HostedPurpose = 'dmarc' | 'spf' | 'tls_rpt' | 'mta_sts';
export type PointerState = 'ok' | 'missing' | 'wrong' | 'error' | null;

export interface HostedPointer {
	purpose: HostedPurpose;
	type: 'CNAME' | 'TXT';
	name: string;
	value: string;
}

export interface HostedStatus {
	enabled: true;
	hosted_id: string;
	mta_sts: boolean;
	records: Record<HostedPurpose, string | null | undefined>;
	pointers: HostedPointer[];
	pointer_status: Record<HostedPurpose, PointerState> & { checked_at: number | null };
	level_inputs: { dmarc_published: boolean; spf_published: boolean; mta_sts_published: boolean };
}

export type HostedResponse = { enabled: false } | HostedStatus;
export interface HostedAddresses {
	rua: string;
	tls_rpt: string;
}
export interface EnableBody {
	spf_record?: string;
	mta_sts?: boolean;
}

export const hostedKey = (id: number) => [...domainKeys.all(id), 'hosted'] as const;
export const HOSTED_CONFIG_KEY = ['hosted-config'] as const;

/** Is hosted mode on for this deployment? Any failure counts as "off": no hosted UI, no further hosted requests. */
export function useHostedConfig(): boolean {
	const q = useQuery({
		queryKey: HOSTED_CONFIG_KEY,
		queryFn: () => api<{ enabled: boolean }>('/api/hosted/config'),
		staleTime: Infinity,
		retry: false,
	});
	return q.data?.enabled === true;
}

export function useHostedStatus(domainId: number) {
	const configEnabled = useHostedConfig();
	return useQuery({
		queryKey: hostedKey(domainId),
		queryFn: () => api<HostedResponse>(`/api/domains/${domainId}/hosted`),
		enabled: configEnabled,
	});
}

/** The status when this domain is hosted (config on and status enabled), else null. */
export function useHostedInfo(domainId: number): HostedStatus | null {
	const q = useHostedStatus(domainId);
	return q.data?.enabled ? q.data : null;
}

/**
 * Writes. The one-time intake addresses go to `onAddresses` (component state) and are NOT returned, so they never
 * sit in the mutation cache; the cache only ever holds the status.
 */
export function useHostedMutations(domainId: number, onAddresses: (a: HostedAddresses) => void) {
	const qc = useQueryClient();
	const base = `/api/domains/${domainId}/hosted`;
	const refresh = () => invalidateDomain(qc, domainId);
	const enable = useMutation({
		mutationFn: async (body: EnableBody) => {
			const r = await api<{ hosted: HostedStatus; addresses: HostedAddresses }>(base, { method: 'POST', body });
			onAddresses(r.addresses);
			return r.hosted;
		},
		onSuccess: () => void refresh(),
		// 409: already enabled elsewhere; the status is the truth now.
		onError: (e) => void (e instanceof ApiError && e.status === 409 ? refresh() : undefined),
	});
	const rotate = useMutation({
		mutationFn: async () => {
			const r = await api<{ addresses: HostedAddresses }>(`${base}/rotate-token`, { method: 'POST', body: {} });
			onAddresses(r.addresses);
		},
		onSuccess: () => void refresh(),
	});
	const disable = useMutation({ mutationFn: () => api(base, { method: 'DELETE' }), onSuccess: refresh });
	const verify = useMutation({
		mutationFn: () => api<HostedResponse>(`${base}/verify`, { method: 'POST', body: {} }),
		onSuccess: (s) => {
			qc.setQueryData(hostedKey(domainId), s);
			void refresh();
		},
	});
	return { enable, rotate, disable, verify };
}

export const PURPOSE_LABEL: Record<HostedPurpose, string> = { dmarc: 'DMARC', spf: 'SPF', tls_rpt: 'TLS-RPT', mta_sts: 'MTA-STS' };
export const PURPOSE_ORDER: HostedPurpose[] = ['dmarc', 'spf', 'tls_rpt', 'mta_sts'];

export const POINTER_STATE_LABEL: Record<'ok' | 'missing' | 'wrong' | 'error' | 'unchecked', string> = {
	ok: 'Verified',
	missing: 'Not found',
	wrong: 'Wrong value',
	error: 'Lookup failed',
	unchecked: 'Not checked yet',
};

export const pointerStateLabel = (s: PointerState | undefined): string => POINTER_STATE_LABEL[s ?? 'unchecked'];

export interface HostedErrorInfo {
	title: string;
	message: string;
	retryable: boolean;
	/** 'conflict' = already enabled, 'input' = user can fix the form, 'full' = capacity, 'dns' = provider failure. */
	kind: 'conflict' | 'input' | 'full' | 'dns' | 'other';
}

/** Maps a failed hosted request to what the UI says and whether a retry can help. The server message is kept. */
export function hostedError(e: unknown): HostedErrorInfo {
	const message = e instanceof Error && e.message ? e.message : 'Something went wrong.';
	if (e instanceof ApiError) {
		switch (e.status) {
			case 409:
				return { title: 'Hosted records are already enabled', message, retryable: false, kind: 'conflict' };
			case 422:
				return { title: 'Check the details and try again', message, retryable: false, kind: 'input' };
			case 502:
				return { title: 'Could not update DNS', message, retryable: true, kind: 'dns' };
			case 507:
				return { title: 'The hosted records zone is full', message, retryable: false, kind: 'full' };
			case 403:
				return { title: 'You do not have access to this', message, retryable: false, kind: 'other' };
		}
		if (e.status >= 400 && e.status < 500) return { title: 'That did not work', message, retryable: false, kind: 'other' };
	}
	return { title: 'That did not work', message, retryable: true, kind: 'other' };
}
