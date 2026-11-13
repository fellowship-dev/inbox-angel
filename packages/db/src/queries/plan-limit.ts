/** A conditional insert refused because the workspace already holds its maximum number of live domains. */
export class PlanLimitError extends Error {
	constructor(readonly kind: 'domains_per_workspace', readonly max: number) {
		super(`plan limit reached: ${kind} ${max}`);
		this.name = 'PlanLimitError';
	}
}

/** Rows changed by a D1 result, whichever driver shape it has. */
export const changesOf = (res: unknown): number => (res as any)?.meta?.changes ?? (res as any)?.changes ?? 0;
