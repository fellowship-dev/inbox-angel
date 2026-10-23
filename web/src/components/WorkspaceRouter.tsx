import { toast } from '@inbox-angel/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { HashRouter } from 'react-router';
import { useSession } from '../lib/session';
import { hashFor, parseHash, workspaceStore } from '../lib/workspace';

/** Data that belongs to no particular workspace: kept when switching. */
const KEEP = new Set(['me', 'auth-status', 'workspaces', 'version']);

/**
 * Hash routing with the workspace in the URL: `#/w/<workspaceId>/domains/1`. React Router's `basename`
 * does the prefixing, so every link and navigation in the app stays workspace-relative (`/domains/1`).
 *
 *  - No workspace in the URL (a bookmark from before, or right after signing in) → once the server has said
 *    which workspace the person is in, the URL is rewritten to name it.
 *  - A workspace the person cannot use → the server's answer wins, with a notice.
 *  - A different workspace → the router remounts and the previous workspace's data is dropped before
 *    anything of the new one renders, so nothing of one workspace can show in another.
 *
 * Invite and reset pages live outside workspaces and are left alone.
 */
export function WorkspaceRouter({ children }: { children: ReactNode }) {
	const { state, me } = useSession();
	const qc = useQueryClient();
	const hash = useSyncExternalStore(workspaceStore.subscribe, () => window.location.hash, () => '');
	const parsed = parseHash(hash);
	const workspaceId = parsed.isPublic ? null : parsed.workspaceId;

	const shown = useRef<string | null | undefined>(undefined);
	if (shown.current !== workspaceId) {
		if (shown.current && workspaceId) {
			void qc.cancelQueries({ predicate: (q) => !KEEP.has(String(q.queryKey[0])) });
			qc.removeQueries({ predicate: (q) => !KEEP.has(String(q.queryKey[0])) });
		}
		shown.current = workspaceId;
	}

	useEffect(() => {
		if (state !== 'authed' || !me?.workspace_id) return;
		const now = parseHash(window.location.hash);
		if (now.isPublic) return;
		workspaceStore.remember(me.workspace_id);
		if (now.workspaceId !== me.workspace_id) {
			if (now.workspaceId) toast({ variant: 'warning', title: 'That workspace is not available to you', description: 'Showing one you belong to instead.' });
			window.location.replace(hashFor(me.workspace_id, now.rest));
		}
	}, [state, me?.workspace_id, hash]);

	return (
		<HashRouter key={workspaceId ?? '-'} basename={workspaceId ? `/w/${encodeURIComponent(workspaceId)}` : undefined}>
			{children}
		</HashRouter>
	);
}
