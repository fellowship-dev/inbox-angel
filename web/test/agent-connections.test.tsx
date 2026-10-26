import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AgentConnectionsSection } from '../src/pages/settings/AgentConnectionsSection';
import { MetricConnectionsSection } from '../src/pages/settings/MetricConnectionsSection';
import { fail, renderApp } from './render';
const empty = { products: [], principals: [], credentials: [], grants: [] };
const connections = { 'GET /api/mcp/connections': { connections: [] } };
describe('operator access', () => {
    it('creates an empty product, maps an existing domain and issues only exact selected capabilities; clears the masked secret', async () => {
        let product = false, mapped = false;
        const { calls } = renderApp(<AgentConnectionsSection />, { routes: {
                ...connections,
                'GET /api/access': () => ({ ...empty, products: product ? [{ id: 'product1', name: 'Receipts' }] : [] }),
                'GET /api/resources': () => ({ domains: [{ id: 7, domain: 'mail.example.com', mappedProductIds: mapped ? ['product1', 'shared-product'] : [] }] }),
                'POST /api/access/products': () => { product = true; return { id: 'product1', name: 'Receipts' }; },
                'PUT /api/access/products/product1/domains/7': () => { mapped = true; return { ok: true }; },
                'POST /api/access/principals': { id: 'principal1' },
                'POST /api/access/grants': { id: 'grant1' },
                'POST /api/access/credentials': { id: 'credential1', key: 'ias_initial-secret-only', prefix: 'ias_ini' },
            } });
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText('New workspace product'), 'Receipts');
        await user.click(screen.getByRole('button', { name: 'Create product' }));
        await user.click(await screen.findByLabelText('mail.example.com'));
        await screen.findByText('mail.example.com · Shared across products');
        const domainBoxes = screen.getAllByRole('checkbox').filter(n => n.closest('fieldset')?.textContent?.includes('Exact credential domains'));
        await user.click(domainBoxes[0]!);
        await user.type(screen.getByLabelText('Service principal and credential name'), 'Receipt worker');
        await user.click(screen.getByRole('button', { name: 'Issue restricted credential' }));
        const secret = await screen.findByLabelText('New credential secret');
        expect(secret).toHaveAttribute('type', 'password');
        expect(secret).toHaveValue('ias_initial-secret-only');
        const grant = calls.find(c => c.path === '/api/access/grants');
        expect(grant?.body).toMatchObject({ principal_id: 'principal1', product_id: 'product1', domain: 'mail.example.com', actions: ['resources:read', 'reports:read'] });
        expect(grant?.body.expires_at).toBeGreaterThan(Date.now() / 1000);
        expect(calls.find(c => c.path === '/api/access/principals')?.body).toEqual({ name: 'Receipt worker', kind: 'service' });
        expect(JSON.stringify({ ...localStorage })).not.toContain('ias_initial-secret-only');
        expect(JSON.stringify({ ...sessionStorage })).not.toContain('ias_initial-secret-only');
        await user.click(screen.getByRole('button', { name: 'Credential stored — clear secret' }));
        await waitFor(() => expect(screen.queryByLabelText('New credential secret')).not.toBeInTheDocument());
    });
    it('keeps a partial principal visible after a failed grant and never blindly creates another', async () => {
        const { calls } = renderApp(<AgentConnectionsSection />, { routes: {
                ...connections, 'GET /api/access': { ...empty, products: [{ id: 'p', name: 'Product' }] },
                'GET /api/resources': { domains: [{ id: 7, domain: 'mail.example.com', mappedProductIds: ['p'] }] },
                'POST /api/access/principals': { id: 'partial1' }, 'POST /api/access/grants': fail(400, 'grant rejected'),
                'DELETE /api/access/principals/partial1': { ok: true },
            } });
        const user = userEvent.setup();
        await user.selectOptions(await screen.findByLabelText('Product'), 'p');
        await user.click(screen.getAllByRole('checkbox')[1]!);
        await user.type(screen.getByLabelText('Service principal and credential name'), 'Worker');
        await user.click(screen.getByRole('button', { name: 'Issue restricted credential' }));
        expect(await screen.findByText(/Principal created: partial1/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Issue restricted credential' })).toBeDisabled();
        expect(calls.filter(c => c.path === '/api/access/principals').length).toBe(1);
        await user.click(screen.getByRole('button', { name: 'Revoke partial principal' }));
        await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
    });
    it('creates a replacement before owner acknowledgement revokes the old credential', async () => {
        const { calls } = renderApp(<AgentConnectionsSection />, { routes: {
                ...connections, 'GET /api/resources': { domains: [] },
                'GET /api/access': { ...empty, principals: [{ id: 'p', name: 'Worker', kind: 'service', disabled_at: null }], credentials: [{ id: 'old', principal_id: 'p', name: 'Worker key', prefix: 'ias_old', expires_at: 9999999999, revoked_at: null }] },
                'POST /api/access/credentials': { id: 'new', key: 'ias_replacement', prefix: 'ias_rep' },
                'DELETE /api/access/credentials/old': { ok: true },
            } });
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Rotate Worker key' }));
        await screen.findByLabelText('New credential secret');
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Replacement stored — revoke previous and clear' }));
        await waitFor(() => expect(calls.some(c => c.path === '/api/access/credentials/old' && c.method === 'DELETE')).toBe(true));
    });
    it('does not offer owner administration to an admin', async () => {
        const { calls } = renderApp(<><AgentConnectionsSection /><MetricConnectionsSection /></>, { role: 'admin', routes: connections });
        await screen.findByText('Only a workspace owner can manage products and service credentials.');
        expect(screen.queryByRole('button', { name: 'Create product' })).not.toBeInTheDocument();
        expect(calls.some(c => c.path === '/api/access' || c.path.startsWith('/api/metrics'))).toBe(false);
    });
    it('shows unconfigured Google as unavailable and disables consent and sync controls', async () => {
        renderApp(<MetricConnectionsSection />, { routes: { 'GET /api/metrics/google/connections': { configured: false, connections: [{ domainId: 7, domain: 'mail.example.com', status: 'not_connected' }] } } });
        expect(await screen.findByRole('status')).toHaveTextContent('not configured');
        expect(screen.getByRole('button', { name: 'Connect Google for mail.example.com' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Sync mail.example.com' })).toBeDisabled();
    });
});
