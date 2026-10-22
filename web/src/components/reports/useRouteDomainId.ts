import { useParams } from 'react-router';

/** `:id` from the route as a number (NaN when missing or malformed). Kept here so pages need not import `app.tsx`, which imports them. */
export function useRouteDomainId(): number {
	const { id } = useParams();
	return Number.parseInt(id ?? '', 10);
}
