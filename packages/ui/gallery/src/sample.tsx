import { Alert, Badge } from "@inbox-angel/ui";
import type { ReactNode } from "react";

/** Every number, domain and record in the gallery is made up. example.test is reserved (RFC 2606). */
export const SAMPLE_DOMAIN = "example.test";

export function SampleBanner({ children }: { children?: ReactNode }) {
	return (
		<Alert variant="info" title="Sample data">
			{children ?? "Everything on this screen is made up for the design gallery. No real domain was looked up."}
		</Alert>
	);
}

export const SampleBadge = () => <Badge variant="outline">Sample</Badge>;
