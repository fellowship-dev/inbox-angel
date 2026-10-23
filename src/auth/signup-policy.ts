// Who may create a user, and which workspace(s) the new user lands in.
//
//  self-host: the first user becomes owner of ws_default; after that, only people holding
//             an invite can sign up. Closed once an owner exists.
//  saas:      anyone can sign up and gets their own workspace (unless invited to another).
//
// Password sign-ups go through our own routes (setup, signup, invite accept), which say why
// the user is being created (`SignupIntent`). OAuth callbacks reach Better Auth directly and
// are 'external': they follow the same rules, but invites are matched by email, which the
// OAuth provider has verified.
import { APIError } from 'better-auth/api';
import { authLookups, forWorkspace, forImplicitWorkspace, globalQueries, IMPLICIT_WORKSPACE_ID, type MembershipRole } from '@inbox-angel/db';
import { isSaas, type AuthEnv } from './config';

export type SignupIntent =
  | { kind: 'external' }
  | { kind: 'setup' }
  | { kind: 'signup' }
  | { kind: 'invite'; token: string };

const now = () => Math.floor(Date.now() / 1000);

async function inviteFor(db: D1Database, intent: SignupIntent, email: string) {
  const invite = intent.kind === 'invite'
    ? await authLookups(db).inviteByToken(intent.token)
    : intent.kind === 'external'
      ? await authLookups(db).pendingInviteForEmail(email, now())
      : null;
  if (!invite || invite.used_at || invite.expires_at < now() || invite.email !== email) return null;
  return invite;
}

/** Throws (rejecting the sign-up) unless this user may be created. */
export async function assertMaySignUp(env: AuthEnv, intent: SignupIntent, email: string): Promise<void> {
  const db = env.DB as D1Database;
  const reject = (message: string) => { throw new APIError('FORBIDDEN', { message }); };

  if (intent.kind === 'invite') {
    if (!(await inviteFor(db, intent, email))) reject('invite not found or expired');
    return;
  }
  if (isSaas(env)) {
    if (intent.kind === 'setup') reject('sign up instead');
    return;
  }
  // Self-host.
  if (intent.kind === 'signup') reject('sign-up is closed — ask an owner for an invite');
  const ownerExists = await forImplicitWorkspace(db).team.hasOwner();
  const claimant = env.OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerExists && claimant && claimant !== email.toLowerCase()) reject('this instance is reserved for its configured owner');
  if (intent.kind === 'setup') {
    if (ownerExists) reject('already configured');
    return;
  }
  if (!ownerExists) return; // first user in via OAuth
  if (!(await inviteFor(db, intent, email))) reject('sign-up is closed — ask an owner for an invite');
}

/** Gives a freshly created user their membership (and in saas mode, their own workspace). */
export async function provisionUser(
  env: AuthEnv,
  intent: SignupIntent,
  user: { id: string; email: string; name: string },
): Promise<{ workspaceId: string; role: MembershipRole }> {
  const db = env.DB as D1Database;
  const fail = async (message: string): Promise<never> => {
    await globalQueries(db).users.delete(user.id);
    throw new APIError('FORBIDDEN', { message });
  };

  let placed: { workspaceId: string; role: MembershipRole } | null = null;

  const invite = await inviteFor(db, intent, user.email);
  if (invite) {
    const role: MembershipRole = invite.role === 'admin' ? 'admin' : 'member';
    const team = forWorkspace(db, invite.workspace_id).team;
    await team.addMember(user.id, role);
    await team.markInviteUsed(invite.token);
    placed = { workspaceId: invite.workspace_id, role };
  } else if (intent.kind === 'invite') {
    return fail('invite not found or expired');
  } else if (isSaas(env)) {
    const workspaceId = `ws_${crypto.randomUUID().replace(/-/g, '')}`;
    await globalQueries(db).workspaces.create(workspaceId, `${user.name || user.email}'s workspace`);
    await forWorkspace(db, workspaceId).team.addMember(user.id, 'owner');
    placed = { workspaceId, role: 'owner' };
  } else {
    // Atomic: of two simultaneous first sign-ups, exactly one becomes owner.
    if (!(await forImplicitWorkspace(db).team.claimOwnership(user.id))) return fail('already configured');
    placed = { workspaceId: IMPLICIT_WORKSPACE_ID, role: 'owner' };
  }

  await globalQueries(db).users.setLegacyRole(user.id, placed.role === 'member' ? 'member' : 'admin');
  return placed;
}
