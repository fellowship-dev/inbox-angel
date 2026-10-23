import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { api, ApiError, onUnauthorized, tokenStore } from './api';
import type { AuthStatus, Me, Role } from './types';
import { workspaceStore } from './workspace';

/** The workspace the dashboard is looking at (URL first, else the last one used). */
export function useWorkspaceId(): string | null {
	return useSyncExternalStore(workspaceStore.subscribe, workspaceStore.get, () => null);
}

export interface Session {
	/** `loading` until we know; `unreachable` when the Worker did not answer (first start runs migrations). */
	state: 'loading' | 'unreachable' | 'anon' | 'authed';
	status: AuthStatus | null;
	me: Me | null;
	role: Role | null;
	/** Owners and admins write; members are read-only (the API enforces it; this only shapes the UI). */
	canWrite: boolean;
	signedIn: (token: string | null) => Promise<void>;
	signOut: () => Promise<void>;
	retry: () => void;
}

const SessionContext = createContext<Session | null>(null);

export const READ_ONLY_REASON = 'Your role is member, which is read-only. Ask an owner or admin to make this change.';

export function SessionProvider({ children }: { children: ReactNode }) {
	const qc = useQueryClient();
	const workspaceId = useWorkspaceId();

	const statusQ = useQuery({
		queryKey: ['auth-status', workspaceId],
		queryFn: () => api<AuthStatus>('/api/auth/status'),
		retry: 4,
		retryDelay: (n) => Math.min(1000 * 2 ** n, 5000),
		staleTime: 60_000,
	});
	const meQ = useQuery({
		queryKey: ['me', workspaceId],
		queryFn: async () => {
			try {
				return await api<Me>('/api/me', { quiet401: true });
			} catch (e) {
				if (e instanceof ApiError && e.status === 401) {
					tokenStore.clear();
					return null;
				}
				// A workspace the person no longer belongs to (left, removed, deleted, or a link from someone else):
				// forget it and let the server pick their oldest. The router then rewrites the URL to match.
				if (e instanceof ApiError && e.status === 403 && workspaceId) {
					workspaceStore.forget();
					return await api<Me>('/api/me', { quiet401: true, workspace: null });
				}
				throw e;
			}
		},
		enabled: statusQ.isSuccess,
		retry: false,
		staleTime: Infinity,
	});

	const signedIn = useCallback(
		async (token: string | null) => {
			if (token) tokenStore.set(token);
			await qc.invalidateQueries({ queryKey: ['auth-status'] });
			await qc.invalidateQueries({ queryKey: ['me'] });
			await qc.invalidateQueries({ queryKey: ['workspaces'] });
		},
		[qc],
	);

	const clearSession = useCallback(() => {
		tokenStore.clear();
		// Forget everything a signed-in user could see, but keep the session queries mounted: they now answer "nobody".
		qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'auth-status' });
		qc.setQueryData(['me', workspaceId], null);
	}, [qc, workspaceId]);

	const signOut = useCallback(async () => {
		await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
		clearSession();
		await qc.invalidateQueries({ queryKey: ['auth-status'] });
	}, [clearSession, qc]);

	useEffect(() => {
		onUnauthorized(clearSession);
		return () => onUnauthorized(null);
	}, [clearSession]);

	const value = useMemo<Session>(() => {
		const me = meQ.data ?? null;
		let state: Session['state'] = 'loading';
		if (statusQ.isError || meQ.isError) state = 'unreachable';
		else if (statusQ.isSuccess && meQ.isSuccess) state = me ? 'authed' : 'anon';
		const role = me?.role ?? null;
		return {
			state,
			status: statusQ.data ?? null,
			me,
			role,
			canWrite: role === 'owner' || role === 'admin',
			signedIn,
			signOut,
			retry: () => {
				void statusQ.refetch();
				void meQ.refetch();
			},
		};
	}, [statusQ, meQ, signedIn, signOut]);

	return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
	const s = useContext(SessionContext);
	if (!s) throw new Error('useSession outside SessionProvider');
	return s;
}

/** For write controls: `disabled` + the reason to show next to them. */
export function useWriteAccess(): { canWrite: boolean; reason: string | undefined } {
	const { canWrite } = useSession();
	return { canWrite, reason: canWrite ? undefined : READ_ONLY_REASON };
}
