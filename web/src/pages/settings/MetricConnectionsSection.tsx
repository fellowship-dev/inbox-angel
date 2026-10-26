import { Button, Card, CardContent, FieldError, Input } from '@inbox-angel/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Section } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useSession, useWorkspaceId } from '../../lib/session';
import { Field } from '../auth/AuthLayout';
import { timestamp } from './AgentConnectionsSection';
interface GoogleConnection {
    domainId: number;
    domain: string;
    status: string;
    id?: string;
    lastAttemptAt?: number | null;
    lastSuccessAt?: number | null;
}
export function MetricConnectionsSection() {
    const { role } = useSession(), workspace = useWorkspaceId(), qc = useQueryClient();
    const q = useQuery({ queryKey: ['google-metric-connections', workspace], queryFn: () => api<{
            configured: boolean;
            connections: GoogleConnection[];
        }>('/api/metrics/google/connections'), enabled: role === 'owner', retry: false });
    const [days, setDays] = useState(30), [busy, setBusy] = useState(false), [error, setError] = useState('');
    async function act(fn: () => Promise<void>) { setError(''); setBusy(true); try {
        await fn();
        await qc.invalidateQueries({ queryKey: ['google-metric-connections'] });
        await qc.invalidateQueries({ queryKey: ['health-report'] });
    }
    catch (e) {
        setError(errorMessage(e));
    }
    finally {
        setBusy(false);
    } }
    return <Section title="Google Postmaster metrics" description="Read Google-reported Gmail metrics for each domain. Google consent does not grant an agent access.">
  {role !== 'owner' ? <p className="text-sm text-ink-2">Only a workspace owner can connect or disconnect Google Postmaster.</p> : q.isPending ? <p>Loading metric connections…</p> : q.isError ? <FieldError>{errorMessage(q.error)}</FieldError> : <Card><CardContent className="p-5 space-y-4 min-w-0">
   {!q.data.configured && <p role="status">Google Postmaster is not configured on this installation. The installer must configure its Google OAuth application and token encryption before connections are available.</p>}
   <p className="text-sm text-ink-2">Provider-suppressed or absent data is unavailable, never zero. Spam complaints, DMARC alignment, TLS and inbox placement measure different populations.</p>
   <Field id="google-sync-days" label="Sync previous days (1–90)"><Input id="google-sync-days" type="number" min={1} max={90} value={days} onChange={e => setDays(Number(e.target.value))}/></Field>
   {!q.data.connections.length && <p>Enroll a domain before connecting Google Postmaster.</p>}
   {q.data.connections.map(c => <div key={c.domainId} className="border-t border-line pt-4 space-y-2 break-words"><h3 className="font-semibold">{c.domain}</h3><p className="text-sm">Status: {c.status.replaceAll('_', ' ')} · Last attempt {timestamp(c.lastAttemptAt)} · Last successful fetch {timestamp(c.lastSuccessAt)}</p>{c.lastSuccessAt && <p className="text-sm text-ink-2">Cache age: {Math.max(0, Math.floor((Date.now() / 1000 - c.lastSuccessAt) / 60))} minutes. Source periods are shown in the domain health report.</p>}<div className="flex flex-wrap gap-2"><Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" variant="secondary" disabled={busy || !q.data.configured} onClick={() => void act(async () => { const result = await api<{
            authorize_url: string;
        }>('/api/metrics/google/oauth/start', { method: 'POST', body: { domain_id: c.domainId } }); window.location.assign(result.authorize_url); })}>{c.status === 'not_connected' ? 'Connect' : 'Reconnect'} Google for {c.domain}</Button><Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" variant="secondary" disabled={busy || !q.data.configured || c.status === 'not_connected' || !Number.isInteger(days) || days < 1 || days > 90} onClick={() => void act(async () => { const until = Math.floor(Date.now() / 1000); await api(`/api/metrics/google/domains/${c.domainId}/sync`, { method: 'POST', body: { since: until - days * 86400, until } }); })}>Sync {c.domain}</Button>{c.status !== 'not_connected' && <Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" variant="danger" disabled={busy} onClick={() => void act(async () => { await api(`/api/metrics/google/domains/${c.domainId}`, { method: 'DELETE' }); })}>Disconnect {c.domain}</Button>}</div></div>)}
   {error && <FieldError>{error}</FieldError>}
  </CardContent></Card>}
 </Section>;
}
