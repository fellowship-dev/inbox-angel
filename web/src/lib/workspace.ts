/**
 * Which workspace the dashboard is looking at. The URL is the source of truth (`#/w/<id>/…`, so links are
 * shareable and a reload keeps context); the last one used is remembered in localStorage and used when
 * the URL names none (e.g. right after signing in). Everything the API returns depends on it, so it is
 * sent as `X-Workspace-Id` with every request.
 */
export const LAST_WORKSPACE_KEY = 'ia_workspace';

/** Pages that exist before (or outside) any workspace: invite and password-reset links. */
const PUBLIC_PREFIXES = ['/invite/', '/reset/', '/forgot'];

export interface ParsedHash {
	/** The workspace in the URL, if any. */
	workspaceId: string | null;
	/** The path inside the workspace (`/` when none), including any query string. */
	rest: string;
	/** An invite / reset page: no workspace prefix, whoever you are. */
	isPublic: boolean;
}

export function parseHash(hash: string): ParsedHash {
	const path = hash.replace(/^#/, '') || '/';
	const m = path.match(/^\/w\/([^/?]+)(\/.*|\?.*)?$/);
	if (m) return { workspaceId: decodeURIComponent(m[1]!), rest: m[2]?.startsWith('?') ? `/${m[2]}` : (m[2] ?? '/'), isPublic: false };
	return { workspaceId: null, rest: path, isPublic: PUBLIC_PREFIXES.some((p) => path.startsWith(p)) };
}

export const hashFor = (workspaceId: string, rest = '/') => `#/w/${encodeURIComponent(workspaceId)}${rest.startsWith('/') ? rest : `/${rest}`}`;

let remembered: string | null = readLast();
function readLast(): string | null {
	try {
		return localStorage.getItem(LAST_WORKSPACE_KEY);
	} catch {
		return null;
	}
}

const listeners = new Set<() => void>();
let started = false;
function start() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('hashchange', () => listeners.forEach((l) => l()));
	window.addEventListener('popstate', () => listeners.forEach((l) => l()));
}

export const workspaceStore = {
	/** The workspace requests are made for: the URL's, else the last one used. */
	get(): string | null {
		return parseHash(window.location.hash).workspaceId ?? remembered;
	},
	/** Remember the workspace the server confirmed, for the next visit. */
	remember(id: string) {
		remembered = id;
		try {
			localStorage.setItem(LAST_WORKSPACE_KEY, id);
		} catch {
			/* private mode: the URL still carries it */
		}
	},
	/** The remembered workspace is gone (left, deleted, access removed). */
	forget() {
		remembered = null;
		try {
			localStorage.removeItem(LAST_WORKSPACE_KEY);
		} catch {
			/* ignore */
		}
	},
	subscribe(listener: () => void) {
		start();
		listeners.add(listener);
		return () => void listeners.delete(listener);
	},
	/** Test hook: re-read localStorage. */
	reload() {
		remembered = readLast();
	},
};

/** sessionStorage flag: the first-run wizard redirect has been offered for this workspace in this tab. */
export const setupSeenKey = (workspaceId: string) => `ia_setup_redirected:${workspaceId}`;
