import { ApiError } from './api';

/** Authenticated file download: the session cookie authenticates it, nothing goes in the URL. */
export async function downloadFile(path: string, filename: string): Promise<void> {
	let res: Response;
	try {
		res = await fetch(path, { credentials: 'same-origin' });
	} catch {
		throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
	}
	if (!res.ok) {
		let message = `Download failed (${res.status})`;
		try {
			message = ((await res.json()) as { error?: string }).error ?? message;
		} catch {
			/* not JSON */
		}
		throw new ApiError(res.status, message);
	}
	const url = URL.createObjectURL(await res.blob());
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
