/**
 * The one place that talks to the Worker's /api. The session is the server's HttpOnly cookie, sent by
 * `credentials: 'same-origin'`; the SPA never sees, stores or logs a session token.
 */
import { workspaceStore } from './workspace';

/** Older builds kept the session token in localStorage under this key. Delete any leftover on startup. */
const LEGACY_TOKEN_KEY = 'ia_api_key';
export function purgeLegacyToken(): void {
	try {
		localStorage.removeItem(LEGACY_TOKEN_KEY);
	} catch {
		/* storage unavailable */
	}
}

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		/** Parsed JSON body when the server sent one (e.g. `needs_confirmation` flows). */
		public readonly body?: unknown,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

const FALLBACK: Record<number, string> = {
	401: 'Your session has ended. Sign in again.',
	403: "You don't have permission to do that.",
	404: 'Not found.',
	409: 'Already exists.',
	429: 'Too many requests. Wait a moment and try again.',
	500: 'Server error. Try again.',
	502: 'A service we depend on failed. Try again shortly.',
	503: 'Service unavailable. Try again shortly.',
};

let unauthorizedHandler: (() => void) | null = null;
/** The session provider registers here so any expired-session 401 signs the user out in one place. */
export function onUnauthorized(handler: (() => void) | null): void {
	unauthorizedHandler = handler;
}

export interface RequestOptions {
	method?: string;
	body?: unknown;
	signal?: AbortSignal;
	/** The caller handles 401 itself (the session probe): don't sign out and wipe the cache. */
	quiet401?: boolean;
	/** Act in this workspace instead of the current one; `null` sends no X-Workspace-Id (the server picks your oldest). */
	workspace?: string | null;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = {};
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
	const workspace = opts.workspace === undefined ? workspaceStore.get() : opts.workspace;
	if (workspace && !path.startsWith('/api/invites/')) headers['X-Workspace-Id'] = workspace;

	let res: Response;
	try {
		res = await fetch(path, {
			method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
			headers,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			credentials: 'same-origin',
			signal: opts.signal,
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === 'AbortError') throw e;
		throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
	}

	if (res.ok) {
		if (res.status === 204) return undefined as T;
		return (await res.json()) as T;
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		/* not JSON */
	}
	const serverMessage = (body as { error?: string } | undefined)?.error;
	// Credential-less endpoints (login, setup …) answer 401 for a wrong password: that is not "session ended".
	if (res.status === 401 && !opts.quiet401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/invites/')) unauthorizedHandler?.();
	throw new ApiError(res.status, serverMessage ?? FALLBACK[res.status] ?? `Unexpected error (${res.status})`, body);
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.');
