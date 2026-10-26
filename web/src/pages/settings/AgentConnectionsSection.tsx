import { Button, Card, CardContent, FieldError, Input, toast } from '@inbox-angel/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Section } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useSession, useWorkspaceId } from '../../lib/session';
import { Field } from '../auth/AuthLayout';
interface Product {
    id: string;
    name: string;
    archived_at?: number | null;
}
interface Principal {
    id: string;
    name: string;
    kind: string;
    disabled_at: number | null;
}
interface Credential {
    id: string;
    principal_id: string;
    name: string;
    prefix: string;
    expires_at: number;
    last_used_at?: number | null;
    revoked_at: number | null;
}
interface Grant {
    id: string;
    principal_id: string;
    domain: string | null;
    actions: string;
    expires_at: number;
    revoked_at: number | null;
}
interface Access {
    products: Product[];
    principals: Principal[];
    credentials: Credential[];
    grants: Grant[];
}
interface Resource {
    id: number;
    domain: string;
    mappedProductIds: string[];
}
interface Connection {
    principalId: string;
    name: string;
    workspaceId: string;
    createdAt: number;
    expiresAt: number;
    lastUsedAt?: number | null;
    revoked?: boolean;
}
interface Issued {
    id: string;
    key: string;
    previousId?: string;
}
const actions = ['resources:read', 'reports:read', 'metrics:read', 'diagnostics:run', 'remediation:plan', 'domains:manage'];
export const accessKey = ['operator-access'];
export const timestamp = (value?: number | null) => value ? new Date(value * 1000).toLocaleString(undefined, { timeZone: 'America/Santiago' }) : 'Never';
async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); toast({ title: 'Copied to clipboard', variant: 'success', duration: 2000 }); }
    catch { toast({ title: 'Could not copy', description: 'Clipboard access was denied. Try again in a secure HTTPS browser.', variant: 'warning' }); }
}
export function AgentConnectionsSection() {
    const { role } = useSession();
    const workspace = useWorkspaceId();
    const qc = useQueryClient();
    const connections = useQuery({ queryKey: ['agent-connections', workspace], queryFn: () => api<{
            connections: Connection[];
        }>('/api/mcp/connections'), retry: false });
    const [error, setError] = useState('');
    const endpoint = `${window.location.origin}/mcp`;
    async function revoke(id: string) { try {
        await api(`/api/mcp/connections/${id}`, { method: 'DELETE' });
        await qc.invalidateQueries({ queryKey: ['agent-connections'] });
    }
    catch (e) {
        setError(errorMessage(e));
    } }
    return <Section title="Agents and product access" description="Connect interactive agents with browser consent, or issue a finite credential for an unattended product.">
  <Card><CardContent className="space-y-4 p-5 min-w-0">
   <Field id="mcp-endpoint" label="This installation's MCP endpoint"><Input id="mcp-endpoint" readOnly value={endpoint}/></Field>
   <Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" variant="secondary" onClick={() => void copy(endpoint)}>Copy MCP endpoint</Button>
   <ol className="list-decimal pl-5 text-sm text-ink-2 space-y-1"><li>Install the Inbox Angel plugin and set this HTTPS endpoint.</li><li>Reload your client so its MCP tools become available.</li><li>Sign in to this installation and approve exact resources, actions and expiry.</li><li>Call whoami, then request a domain health report. Installation alone does not establish a connection.</li></ol>
   <h3 className="font-semibold">Your browser-authorized agents</h3>
   {connections.isPending ? <p>Loading connections…</p> : connections.isError ? <FieldError>{errorMessage(connections.error)}</FieldError> : !connections.data.connections.length ? <p className="text-sm text-ink-2">No authorized agents yet.</p> : connections.data.connections.map(c => <div key={c.principalId} className="border-t border-line pt-3 break-words"><p className="font-medium">{c.name}</p><p className="text-sm text-ink-2">Workspace {c.workspaceId} · Created {timestamp(c.createdAt)} · Expires {timestamp(c.expiresAt)} · Last used {c.lastUsedAt === undefined ? 'Not recorded' : timestamp(c.lastUsedAt)}</p>{c.revoked ? <p>Revoked</p> : <Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" size="sm" variant="danger" onClick={() => void revoke(c.principalId)}>Revoke {c.name}</Button>}</div>)}
   {error && <FieldError>{error}</FieldError>}
  </CardContent></Card>
  {role === 'owner' ? <ProductAccess key={workspace}/> : <p className="text-sm text-ink-2">Only a workspace owner can manage products and service credentials.</p>}
 </Section>;
}
function ProductAccess() {
    const workspace = useWorkspaceId(), qc = useQueryClient();
    const access = useQuery({ queryKey: [...accessKey, workspace], queryFn: () => api<Access>('/api/access'), retry: false });
    const resources = useQuery({ queryKey: ['operator-resources', workspace], queryFn: () => api<{
            domains: Resource[];
        }>('/api/resources'), retry: false });
    const [productName, setProductName] = useState(''), [product, setProduct] = useState('');
    const [name, setName] = useState(''), [selected, setSelected] = useState<number[]>([]), [allowed, setAllowed] = useState(['resources:read', 'reports:read']);
    const [days, setDays] = useState(30), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const [partial, setPartial] = useState<string | null>(null), [issued, setIssued] = useState<Issued | null>(null);
    const refresh = async () => { await qc.invalidateQueries({ queryKey: accessKey }); await qc.invalidateQueries({ queryKey: ['operator-resources'] }); };
    async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try {
        await fn();
    }
    catch (e) {
        setError(errorMessage(e));
    }
    finally {
        setBusy(false);
        await refresh();
    } }
    async function createProduct(e: FormEvent) { e.preventDefault(); await run(async () => { const p = await api<Product>('/api/access/products', { method: 'POST', body: { name: productName.trim() } }); setProduct(p.id); setProductName(''); setSelected([]); }); }
    async function map(id: number, mapped: boolean) { await run(async () => { await api(`/api/access/products/${product}/domains/${id}`, { method: mapped ? 'DELETE' : 'PUT' }); setSelected(s => s.filter(x => x !== id)); }); }
    async function issue(e: FormEvent) {
        e.preventDefault();
        if (!selected.length || !allowed.length || partial)
            return;
        await run(async () => {
            const p = await api<Principal>('/api/access/principals', { method: 'POST', body: { name: name.trim(), kind: 'service' } });
            setPartial(p.id);
            const expires_at = Math.floor(Date.now() / 1000) + days * 86400;
            for (const id of selected) {
                const domain = resources.data!.domains.find(d => d.id === id)!;
                await api('/api/access/grants', { method: 'POST', body: { principal_id: p.id, product_id: product, domain: domain.domain, actions: allowed, expires_at } });
            }
            const credential = await api<Issued>('/api/access/credentials', { method: 'POST', body: { principal_id: p.id, name: name.trim(), expires_at } });
            setIssued(credential);
            setPartial(null);
            setName('');
        });
    }
    async function revoke(type: string, id: string) { await run(async () => { await api(`/api/access/${type}/${id}`, { method: 'DELETE' }); if (type === 'principals' && partial === id)
        setPartial(null); }); }
    async function rotate(c: Credential) { await run(async () => { const next = await api<Issued>('/api/access/credentials', { method: 'POST', body: { principal_id: c.principal_id, name: `${c.name} replacement`.slice(0, 80), expires_at: Math.floor(Date.now() / 1000) + days * 86400 } }); setIssued({ ...next, previousId: c.id }); }); }
    if (access.isPending || resources.isPending)
        return <p>Loading product access…</p>;
    if (access.isError || resources.isError)
        return <FieldError>{errorMessage(access.error || resources.error)}</FieldError>;
    const validExpiry = Number.isSafeInteger(days) && days > 0 && Number.isSafeInteger(Math.floor(Date.now() / 1000) + days * 86400);
    const mapped = resources.data.domains.filter(d => d.mappedProductIds.includes(product));
    return <Card><CardContent className="space-y-6 p-5 min-w-0">
  <h3 className="font-semibold">Products and service credentials</h3>
  <form onSubmit={createProduct} className="flex flex-wrap items-end gap-3"><Field id="product-name" label="New workspace product"><Input id="product-name" required maxLength={80} value={productName} onChange={e => setProductName(e.target.value)}/></Field><Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" loading={busy} type="submit">Create product</Button></form>
  {!access.data.products.length && <p className="text-sm text-ink-2">Create your first product to group its authorized domains.</p>}
  <Field id="access-product" label="Product"><select id="access-product" className="w-full rounded border border-line bg-surface-1 p-2" value={product} onChange={e => { setProduct(e.target.value); setSelected([]); }}><option value="">Select a product</option>{access.data.products.filter(p => !p.archived_at).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
  {product && <div className="space-y-3"><h4 className="font-medium">Assign existing domains</h4><p className="text-sm text-ink-2">A domain can belong to multiple products. Its telemetry always covers the shared domain; it cannot identify one product's share.</p>{!resources.data.domains.length && <Link to="/add" className="underline text-brand-ink">Enroll a domain first</Link>}{resources.data.domains.map(d => <label key={d.id} className="flex min-w-0 items-start gap-2 text-sm break-all"><input type="checkbox" disabled={busy} checked={d.mappedProductIds.includes(product)} onChange={() => void map(d.id, d.mappedProductIds.includes(product))}/><span>{d.domain}{d.mappedProductIds.length > 1 ? ' · Shared across products' : ''}</span></label>)}</div>}
  <form onSubmit={issue} className="space-y-4">
   <Field id="principal-name" label="Service principal and credential name"><Input id="principal-name" required maxLength={80} value={name} onChange={e => setName(e.target.value)}/></Field>
   <fieldset className="space-y-2"><legend className="font-medium">Exact credential domains</legend>{!mapped.length && <p className="text-sm text-ink-2">Select a product and assign at least one domain above.</p>}{mapped.map(d => <label key={d.id} className="flex min-w-0 gap-2 text-sm break-all"><input type="checkbox" checked={selected.includes(d.id)} onChange={e => setSelected(s => e.target.checked ? [...s, d.id] : s.filter(x => x !== d.id))}/>{d.domain}</label>)}</fieldset>
   <fieldset className="grid gap-2 sm:grid-cols-2"><legend className="font-medium">Allowed actions</legend>{actions.map(a => <label key={a} className="flex min-w-0 gap-2 text-sm break-all"><input type="checkbox" checked={allowed.includes(a)} onChange={e => setAllowed(s => e.target.checked ? [...s, a] : s.filter(x => x !== a))}/>{a}</label>)}</fieldset>
   <Field id="credential-days" label="Credential and grants expire in days"><Input id="credential-days" type="number" required min={1} value={days} onChange={e => setDays(Number(e.target.value))}/></Field>
   <Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" type="submit" loading={busy} disabled={!validExpiry || !product || !selected.length || !allowed.length || !!partial || !!issued}>Issue restricted credential</Button>
  </form>
  {partial && <div role="alert" className="space-y-2"><p>Principal created: {partial}. Issuance stopped before completion. Review its grants below or revoke this partial principal before starting again.</p><Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" variant="danger" disabled={busy} onClick={() => void revoke('principals', partial)}>Revoke partial principal</Button></div>}
  {issued && <div role="status" className="space-y-3 rounded border border-line p-4"><p className="font-medium">Save this credential now. It cannot be shown again.</p><Input aria-label="New credential secret" type="password" readOnly autoComplete="off" value={issued.key}/><Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" variant="secondary" onClick={() => void copy(issued.key)}>Copy new credential</Button>{issued.previousId && <p>The previous credential remains active until you confirm the replacement is stored.</p>}<Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" disabled={busy} onClick={() => void run(async () => { if (issued.previousId)
        await api(`/api/access/credentials/${issued.previousId}`, { method: 'DELETE' }); setIssued(null); })}>{issued.previousId ? 'Replacement stored — revoke previous and clear' : 'Credential stored — clear secret'}</Button></div>}
  {error && <FieldError>{error}</FieldError>}
  <div className="space-y-4"><h4 className="font-semibold">Service principals</h4><p className="text-sm text-ink-2">Rotation preserves existing grants and their expiry. The replacement credential uses the expiry selected above.</p>{access.data.principals.filter(p => p.kind === 'service').map(p => <div key={p.id} className="space-y-2 border-t border-line pt-3 break-words"><p>{p.name} {p.disabled_at !== null ? '· Disabled' : ''}</p>{p.disabled_at === null && <Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" size="sm" variant="danger" disabled={busy} onClick={() => void revoke('principals', p.id)}>Disable {p.name}</Button>}{access.data.grants.filter(g => g.principal_id === p.id).map(g => <div key={g.id} className="text-sm"><p>{g.domain} · {g.actions} · Expires {timestamp(g.expires_at)} {g.revoked_at !== null ? '· Revoked' : ''}</p>{g.revoked_at === null && <Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" size="sm" variant="secondary" disabled={busy} onClick={() => void revoke('grants', g.id)}>Revoke domain grant</Button>}</div>)}{access.data.credentials.filter(c => c.principal_id === p.id).map(c => <div key={c.id} className="space-y-2 text-sm"><p>{c.name} · {c.prefix}… · Expires {timestamp(c.expires_at)} · Last used {timestamp(c.last_used_at)} {c.revoked_at !== null ? '· Revoked' : ''}</p>{c.revoked_at === null && <div className="flex flex-wrap gap-2"><Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" size="sm" variant="secondary" disabled={busy || !!issued || !validExpiry || p.disabled_at !== null} onClick={() => void rotate(c)}>Rotate {c.name}</Button><Button className="max-w-full h-auto min-h-10 whitespace-normal break-words py-2" size="sm" variant="danger" disabled={busy} onClick={() => void revoke('credentials', c.id)}>Revoke {c.name}</Button></div>}</div>)}</div>)}</div>
 </CardContent></Card>;
}
