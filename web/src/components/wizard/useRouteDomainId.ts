import { useParams } from 'react-router';

/** `:id` from the route (the route table has already rejected non-numeric ids). */
export function useRouteDomainId(): number {
	return Number.parseInt(useParams().id ?? '', 10);
}
