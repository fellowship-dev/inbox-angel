/** Original provider rates are never averaged or converted to percentages. */
export interface MetricObservation {
 sourceId: string; metric: string; definition: string; filter: string | null;
 value: number | string; unit: 'provider-rate' | 'messages'; denominator: number | null;
 periodStart: string; periodEnd: string; fetchedAt: number;
 status: 'available'; source: 'google-postmaster-v2'; population: string; coverage: 'shared-domain';
}
export type GoogleStatus = 'connected' | 'disconnected' | 'permission_denied' | 'token_revoked' | 'rate_limited' | 'provider_error' | 'no_data';
export interface MetricWindow { since: number; until: number }
