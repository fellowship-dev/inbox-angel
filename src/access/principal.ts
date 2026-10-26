import type { MembershipRole } from '@inbox-angel/db';
import type { AccessGrant } from './grant';
export interface AccessSubject {
  principalId: string;
  credentialId?: string;
  kind: 'human' | 'service';
  workspaceId: string;
  userId?: string;
  disabledAt?: number | null;
  memberships?: { workspaceId: string; role: MembershipRole }[];
  grants: AccessGrant[];
  /** Session authority is never set on a delegated credential. */
  session?: boolean;
}
