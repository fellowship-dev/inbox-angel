import { forImplicitWorkspace } from '@inbox-angel/db';
import type { AuthEnv } from './config';
import { hashApiKey } from './api-keys';

/** Installer-held capability. Never accepted in URLs, persisted in clear, or returned to clients. */
export async function verifyBootstrapProof(env: AuthEnv, proof: unknown): Promise<boolean> {
 if (!env.BOOTSTRAP_SECRET || env.BOOTSTRAP_SECRET.length < 32 || typeof proof !== 'string' || proof.length > 512) return false;
 if (await forImplicitWorkspace(env.DB!).settings.get('bootstrap_consumed')) return false;
 const [actual, expected] = await Promise.all([hashApiKey(proof), hashApiKey(env.BOOTSTRAP_SECRET)]);
 let difference = 0;
 for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
 return difference === 0;
}
export async function consumeBootstrapProof(env: AuthEnv): Promise<void> {
 await forImplicitWorkspace(env.DB!).settings.set('bootstrap_consumed', 'true');
}
