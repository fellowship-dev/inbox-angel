// Which tenant serves an MTA-STS policy hostname.
//
//   self-host   mta-sts.<domain>                 → the implicit workspace
//   saas        mta-sts.<id>.h.<zone>            → the tenant whose hosted id is <id>   (our own zone)
//               mta-sts.<customer domain>        → the tenant that hosts that domain    (customer CNAME)
//
// Never the default workspace in saas: an unknown host is a 404.

import type { Env } from '../index';
import { intakeLookups } from '@inbox-angel/db';
import { getMode } from '../tenancy/mode';
import { resolveDomainOwner } from '../tenancy/resolver';
import { hostedApex, hostedConfig } from './config';
import { isHostedIdShaped } from './tokens';

export interface PolicyHost { workspaceId: string; domain: string }

/** `mta-sts.<id>` + `.h.inboxangel.io` → <id>, or null if the hostname isn't one of ours. */
export function hostedIdFromHost(env: Env, hostname: string): string | null {
  const apex = hostedApex(hostedConfig(env));
  const host = hostname.toLowerCase();
  if (!apex || !host.endsWith(`.${apex}`)) return null;
  const inner = host.slice(0, -(apex.length + 1));
  if (!inner.startsWith('mta-sts.')) return null;
  const id = inner.slice('mta-sts.'.length);
  return isHostedIdShaped(id) ? id : null;
}

export async function resolvePolicyHost(env: Env, hostname: string): Promise<PolicyHost | null> {
  const host = hostname.toLowerCase();
  if (getMode(env) === 'saas') {
    if (!env.DB) return null;
    const id = hostedIdFromHost(env, host);
    if (id) {
      const target = await intakeLookups(env.DB).hostedById(id);
      return target ? { workspaceId: target.workspace_id, domain: target.domain } : null;
    }
  }
  const domain = host.slice('mta-sts.'.length);
  const owner = await resolveDomainOwner(env, domain);
  return owner ? { workspaceId: owner, domain } : null;
}
