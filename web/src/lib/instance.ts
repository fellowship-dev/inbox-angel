import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useSession } from './session';
import type { AgentStatus, Preflight } from './types';

/** Whether agents can connect to this instance, and the MCP server URL they use. */
export function useAgentStatus() {
	return useQuery({ queryKey: ['agent-status'], queryFn: () => api<AgentStatus>('/api/agents/status'), staleTime: 300_000, retry: false });
}

/** The configuration check. Only the person who runs the instance asks for it; everyone else never sees it. */
export function usePreflight() {
	const { me } = useSession();
	const owner = !!me?.instance_owner;
	return { owner, query: useQuery({ queryKey: ['instance-preflight'], queryFn: () => api<Preflight>('/api/instance/preflight'), enabled: owner, staleTime: 300_000, retry: false }) };
}

/** What a person types to their assistant after connecting. Read-only on purpose: it asks for advice, not changes. */
export const FIRST_PROMPT =
	'Use the Ready Set Mail connector. First call whoami to see which domains I gave you access to, then list_domains. ' +
	'For each domain (start with five if there are more, and ask me before doing the rest), get its email health report. ' +
	'Then tell me in plain words the three things that matter most for my email being trusted, most urgent first. ' +
	'For each one, say what to change, where, and how I can check that it worked. ' +
	"Don't change anything yourself: if a fix needs a DNS change or a stricter DMARC policy, tell me and I'll make it.";
