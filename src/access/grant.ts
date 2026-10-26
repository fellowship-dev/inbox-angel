/** Capabilities are exact, never wildcard strings. Grants enumerate resources at consent time. */
export const ACCESS_ACTIONS = ['resources:read', 'diagnostics:run', 'domains:manage', 'reports:read', 'metrics:read', 'remediation:plan', 'access:manage'] as const;
export type AccessAction = typeof ACCESS_ACTIONS[number];
export interface AccessResource { workspaceId: string; productId?: string; domain?: string }
export interface AccessGrant extends AccessResource {
  id: string;
  actions: AccessAction[];
  expiresAt: number;
  revokedAt: number | null;
}
export function validActions(value: unknown): value is AccessAction[] {
  return Array.isArray(value) && value.length > 0 && value.every(a => ACCESS_ACTIONS.includes(a));
}
