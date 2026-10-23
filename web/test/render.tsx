import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { createQueryClient } from '../src/lib/query';
import { SessionProvider, useSession } from '../src/lib/session';
import type { AuthStatus, Me } from '../src/lib/types';

export const STATUS: AuthStatus = {
	configured: true,
	mode: 'self-host',
	signup_open: false,
	oauth_providers: [],
	prefill: { name: '', email: '' },
	telemetry_default: false,
	turnstile_site_key: null,
	custom_domain: null,
	base_domain: 'example.com',
	has_domain: true,
};

export const me = (role: Me['role'] = 'owner'): Me => ({ user: { id: 'u1', email: `${role}@example.com`, name: role }, role, workspace_id: 'ws_default', kind: 'session' });

export type Handler = (req: { method: string; path: string; body: any; headers: Record<string, string> }) => unknown | Response | undefined;

/**
 * Stubs `fetch` with a router: `routes` maps "METHOD /path" to a JSON body, a status/body pair, or a function.
 * Unmatched requests fail the test loudly (a missing mock is a bug, not a 404).
 */
export function mockApi(routes: Record<string, unknown | Handler>) {
	const calls: Array<{ method: string; path: string; body: any; headers: Record<string, string> }> = [];
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), 'http://localhost');
		const method = (init?.method ?? 'GET').toUpperCase();
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const path = url.pathname + url.search;
		const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
		calls.push({ method, path, body, headers });
		const hit = routes[`${method} ${path}`] ?? routes[`${method} ${url.pathname}`];
		if (hit === undefined) throw new Error(`unmocked request: ${method} ${path}`);
		const out = typeof hit === 'function' ? (hit as Handler)({ method, path, body, headers }) : hit;
		if (out instanceof Response) return out;
		if (out && typeof out === 'object' && '__status' in out) {
			const { __status, ...rest } = out as { __status: number; body?: unknown };
			return Response.json(rest.body ?? {}, { status: __status });
		}
		return Response.json(out ?? {});
	});
	vi.stubGlobal('fetch', fn);
	return { calls, fn };
}

/** A non-2xx JSON response for `mockApi`. */
export const fail = (status: number, error?: string) => ({ __status: status, body: error ? { error } : {} });

/**
 * Renders `ui` inside the app's providers, signed in as `role` (`null` = signed out), with `routes` mocked
 * on top of the session endpoints.
 */
export function renderApp(
	ui: ReactElement,
	opts: { route?: string; role?: Me['role'] | null; status?: Partial<AuthStatus>; routes?: Record<string, unknown | Handler> } = {},
) {
	const role = opts.role === undefined ? 'owner' : opts.role;
	const api = mockApi({
		'GET /api/auth/status': { ...STATUS, ...opts.status },
		'GET /api/me': role ? me(role) : fail(401),
		...opts.routes,
	});
	return { ...api, ...render(wrap(ui, opts.route)) };
}

/** Like the app's Gate: signed-in pages only render once the session (and so the role) is known. */
function Ready({ children }: { children: ReactNode }) {
	const { state } = useSession();
	return state === 'authed' || state === 'anon' ? <>{children}</> : null;
}

export function wrap(ui: ReactElement, route = '/') {
	return (
		<QueryClientProvider client={createQueryClient()}>
			<SessionProvider>
				<Ready>
					<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
				</Ready>
			</SessionProvider>
		</QueryClientProvider>
	);
}
