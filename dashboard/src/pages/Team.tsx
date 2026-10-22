import { useEffect, useState } from 'preact/hooks';
import { getTeam, inviteTeamMember, removeTeamMember } from '../api';
import type { TeamMember } from '../api';
import { formatDate } from '../utils/dates';

interface Props {
  onUnauthorized: () => void;
}

export function Team({ onUnauthorized }: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Remove
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const { users, current_user_id } = await getTeam();
      setMembers(users);
      setCurrentUserId(current_user_id);
    } catch (e: any) {
      if (e.message === '401' || e.message === '403') { onUnauthorized(); return; }
      setError(e.message ?? 'Failed to load team');
    } finally {
      setLoading(false);
    }
  }

  const sendInvite = async (e: Event) => {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    setInviteLink(null);
    try {
      const { token } = await inviteTeamMember(inviteEmail);
      setInviteLink(`${window.location.origin}/#/invite/${token}`);
      setInviteEmail('');
    } catch (e: any) {
      if (e.message === '401' || e.message === '403') { onUnauthorized(); return; }
      setInviteError(e.message ?? 'Failed to create invite');
    } finally {
      setInviting(false);
    }
  };

  const remove = async (id: string) => {
    setRemovingId(id);
    try {
      await removeTeamMember(id);
      setMembers(prev => prev.filter(m => m.id !== id));
    } catch (e: any) {
      if (e.message === '401' || e.message === '403') { onUnauthorized(); return; }
    } finally {
      setRemovingId(null);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <h2 style={s.title}>Team</h2>
      <p style={s.subtitle}>Members can access all domains and reports. Admins can manage the team.</p>

      {/* Members list */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>Members</h3>
        {loading && <p style={s.muted}>Loading…</p>}
        {error && <p style={{ color: '#dc2626', fontSize: '0.875rem' }}>{error}</p>}
        {!loading && !error && (
          <div style={s.card}>
            {members.map((m, i) => (
              <div key={m.id}>
                {i > 0 && <div style={s.divider} />}
                <div style={s.row}>
                  <div style={s.avatar}>{m.name[0]?.toUpperCase() ?? '?'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.memberName}>{m.name}</div>
                    <div style={s.memberEmail}>{m.email}</div>
                  </div>
                  <span style={{ ...s.badge, background: m.role !== 'member' ? '#ede9fe' : '#f3f4f6', color: m.role !== 'member' ? '#6d28d9' : '#374151' }}>
                    {m.role}
                  </span>
                  <span style={s.muted}>{m.last_login_at ? formatDate(m.last_login_at) : 'Never logged in'}</span>
                  {m.id !== currentUserId && (
                    <button
                      style={s.removeBtn}
                      onClick={() => remove(m.id)}
                      disabled={removingId === m.id}
                      title="Remove member"
                    >
                      {removingId === m.id ? '…' : '✕'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Invite */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>Invite someone</h3>
        <div style={s.card}>
          <form onSubmit={sendInvite} style={s.inviteForm}>
            <input
              type="email"
              placeholder="colleague@company.com"
              value={inviteEmail}
              onInput={e => setInviteEmail((e.target as HTMLInputElement).value)}
              style={s.input}
              required
            />
            <button type="submit" style={s.inviteBtn} disabled={inviting}>
              {inviting ? 'Generating…' : 'Generate invite link'}
            </button>
          </form>
          {inviteError && <p style={s.inviteError}>{inviteError}</p>}
          {inviteLink && (
            <div style={s.linkBox}>
              <p style={s.linkLabel}>
                Send this link to your teammate. It expires in 7 days and can only be used once.
              </p>
              <div style={s.linkRow}>
                <code style={s.linkCode}>{inviteLink}</code>
                <button style={s.copyBtn} onClick={() => copy(inviteLink)}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

const s = {
  title: { margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 700 } as const,
  subtitle: { margin: '0 0 2rem', color: '#6b7280', fontSize: '0.875rem' } as const,
  section: { marginBottom: '2.5rem' } as const,
  sectionTitle: { fontSize: '0.75rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.06em', margin: '0 0 0.75rem' },
  card: { border: '1px solid #e5e7eb', borderRadius: '8px', overflow: 'hidden' } as const,
  divider: { borderTop: '1px solid #f3f4f6' } as const,
  row: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.85rem 1rem', flexWrap: 'wrap' as const },
  avatar: { width: '2rem', height: '2rem', borderRadius: '50%', background: '#e0e7ff', color: '#4f46e5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.875rem', flexShrink: 0 } as const,
  memberName: { fontSize: '0.875rem', fontWeight: 600, color: '#111827' } as const,
  memberEmail: { fontSize: '0.75rem', color: '#9ca3af' } as const,
  badge: { fontSize: '0.7rem', fontWeight: 600, padding: '0.2rem 0.5rem', borderRadius: '4px', flexShrink: 0 } as const,
  muted: { fontSize: '0.75rem', color: '#9ca3af', flexShrink: 0 } as const,
  removeBtn: { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: '0.2rem 0.4rem', borderRadius: '4px', fontSize: '0.8rem', flexShrink: 0 } as const,
  inviteForm: { display: 'flex', gap: '0.5rem', padding: '1rem', flexWrap: 'wrap' as const },
  input: { flex: 1, minWidth: '200px', padding: '0.55rem 0.75rem', border: '1.5px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem', fontFamily: 'inherit', outline: 'none' } as const,
  inviteBtn: { padding: '0.55rem 1rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const } as const,
  inviteError: { color: '#dc2626', fontSize: '0.8rem', margin: '0 1rem 0.75rem' } as const,
  linkBox: { borderTop: '1px solid #f3f4f6', padding: '1rem' } as const,
  linkLabel: { margin: '0 0 0.75rem', fontSize: '0.8rem', color: '#6b7280' } as const,
  linkRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' as const },
  linkCode: { flex: 1, minWidth: 0, fontSize: '0.75rem', fontFamily: 'monospace', color: '#111827', background: '#f9fafb', padding: '0.4rem 0.6rem', borderRadius: '4px', wordBreak: 'break-all' as const },
  copyBtn: { padding: '0.35rem 0.75rem', background: '#111827', color: '#fff', border: 'none', borderRadius: '4px', fontSize: '0.75rem', cursor: 'pointer', flexShrink: 0 } as const,
};
