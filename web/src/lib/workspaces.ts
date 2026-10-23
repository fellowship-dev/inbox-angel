import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@inbox-angel/ui';
import { api, errorMessage } from './api';
import type { Role } from './types';
import { hashFor, workspaceStore } from './workspace';

export interface WorkspaceSummary {
	id: string;
	name: string;
	role: Role;
	member_count: number;
	created_at: number;
}

export const workspaceKeys = { all: ['workspaces'] as const };

/** Every workspace the signed-in user belongs to (independent of the one selected). */
export function useWorkspaces(enabled = true) {
	return useQuery({
		queryKey: workspaceKeys.all,
		queryFn: () => api<{ workspaces: WorkspaceSummary[] }>('/api/workspaces').then((r) => r.workspaces),
		enabled,
		staleTime: 30_000,
	});
}

/** Open a workspace: the URL changes, the router remounts, the previous workspace's data is dropped. */
export function switchToWorkspace(id: string, rest = '/') {
	workspaceStore.remember(id);
	window.location.hash = hashFor(id, rest);
}

export function useCreateWorkspace(onCreated?: (w: { id: string; name: string }) => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api<{ id: string; name: string }>('/api/workspaces', { method: 'POST', body: { name } }),
		onSuccess: async (w) => {
			await qc.invalidateQueries({ queryKey: workspaceKeys.all });
			onCreated?.(w);
		},
	});
}

export function useRenameWorkspace(id: string) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (name: string) => api(`/api/workspaces/${id}`, { method: 'PATCH', body: { name } }),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: workspaceKeys.all });
			toast({ variant: 'success', title: 'Workspace renamed' });
		},
	});
}

/** Leave or delete: afterwards the person is somewhere that still exists. */
export function useLeaveWorkspace(id: string, then: () => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => api(`/api/workspaces/${id}/leave`, { method: 'POST', body: {} }),
		onSuccess: async () => {
			workspaceStore.forget();
			await qc.invalidateQueries({ queryKey: workspaceKeys.all });
			toast({ variant: 'success', title: 'You left the workspace' });
			then();
		},
		onError: (e) => toast({ variant: 'danger', title: 'Could not leave', description: errorMessage(e) }),
	});
}

export function useDeleteWorkspace(id: string, then: () => void) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (confirm?: string) => api(`/api/workspaces/${id}${confirm ? `?confirm=${encodeURIComponent(confirm)}` : ''}`, { method: 'DELETE' }),
		onSuccess: async () => {
			workspaceStore.forget();
			await qc.invalidateQueries({ queryKey: workspaceKeys.all });
			toast({ variant: 'success', title: 'Workspace deleted' });
			then();
		},
	});
}
