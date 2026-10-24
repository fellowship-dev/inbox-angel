// Configuration of the email funnel, all from the environment.

import type { Env } from '../index';
import { hostedEnabled } from '../hosted/config';

export type FunnelEnv = Pick<
  Env,
  | 'MODE' | 'SAAS_ENABLED' | 'ONBOARDING_SEQUENCE_ENABLED' | 'PUBLIC_BASE_URL' | 'BETTER_AUTH_URL' | 'POSTAL_ADDRESS' | 'BOOKING_URL'
  | 'SERVICE_PRICES' | 'MAIL_FROM' | 'MAIL_FROM_NAME' | 'MAIL_REPLY_TO' | 'CANARY_DOMAIN' | 'SITE_ORIGINS'
>;

/** Hosted: on unless ONBOARDING_SEQUENCE_ENABLED=0. Self-host: off unless ONBOARDING_SEQUENCE_ENABLED=1. */
export function sequenceEnabled(env: FunnelEnv): boolean {
  return hostedEnabled(env) ? env.ONBOARDING_SEQUENCE_ENABLED !== '0' : env.ONBOARDING_SEQUENCE_ENABLED === '1';
}

/** Public origin for links in email, no trailing slash. Null when none is configured. */
export function publicBaseUrl(env: FunnelEnv): string | null {
  const raw = (env.PUBLIC_BASE_URL || env.BETTER_AUTH_URL || '').trim().replace(/\/+$/, '');
  // HTTPS only (Cloudflare and mailbox providers reject a plain-HTTP List-Unsubscribe); http is accepted for localhost development.
  return /^https:\/\/[^\s/]+/i.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw) ? raw : null;
}

export const postalAddress = (env: FunnelEnv): string | null => env.POSTAL_ADDRESS?.trim() || null;
export const bookingUrl = (env: FunnelEnv): string | null => (/^https?:\/\//i.test(env.BOOKING_URL?.trim() ?? '') ? env.BOOKING_URL!.trim() : null);

export interface ServicePrices { fix?: string; keepFixed?: string; bimi?: string }

/** The "from" prices, as configured. Nothing is hardcoded: an unset or malformed value means "no prices yet". */
export function servicePrices(env: FunnelEnv): ServicePrices {
  try {
    const raw = JSON.parse(env.SERVICE_PRICES ?? '{}') as Record<string, unknown>;
    const out: ServicePrices = {};
    for (const k of ['fix', 'keepFixed', 'bimi'] as const) if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k] as string;
    return out;
  } catch {
    return {};
  }
}

export function funnelSender(env: FunnelEnv): { name: string; email: string } | null {
  const email = env.MAIL_FROM?.trim() || (env.CANARY_DOMAIN ? `noreply@${env.CANARY_DOMAIN.trim().toLowerCase()}` : '');
  return email ? { name: env.MAIL_FROM_NAME?.trim() || 'Inbox Angel', email } : null;
}

export function siteOrigins(env: FunnelEnv): string[] {
  return (env.SITE_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => /^https?:\/\/[^*\s]+$/i.test(o));
}
