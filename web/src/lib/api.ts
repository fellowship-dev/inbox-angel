/**
 * The one place that talks to the Worker's /api. The token lives in localStorage under the same key
 * the Preact dashboard used, so people stay signed in across the switch. OAuth sign-ins have no token:
 * they rely on the session cookie, which `credentials: 'same-origin'` sends.
 */
export const TOKEN_KEY = 'ia_api_key';

export const tokenStore = {
	get: () => localStorage.getItem(TOKEN_KEY) ?? '',
	set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
	clear: () => localStorage.removeItem(TOKEN_KEY),
};

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
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = {};
	const token = tokenStore.get();
	if (token) headers['X-Api-Key'] = token;
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

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
