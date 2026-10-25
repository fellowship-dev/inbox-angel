import { Alert, Badge } from "@inbox-angel/ui";
import type { ReactNode } from "react";

/** `?fixture=long` swaps in worst-case lengths to prove nothing overflows the document. */
export const LONG_FIXTURE = new URLSearchParams(window.location.search).get("fixture") === "long";

/** Every number, domain and record in the gallery is made up. `.test` is reserved (RFC 2606). */
export const SAMPLE_DOMAIN = LONG_FIXTURE ? "customer-onboarding-and-billing-notifications.eu-west.mail-platform.example.test" : "example.test";
export const SAMPLE_EMAIL = LONG_FIXTURE ? "first.name.with-a-very-long-local-part+reports-and-alerts@customer-onboarding-and-billing-notifications.example.test" : "reports@example.test";
export const SAMPLE_DKIM = `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA${"Q2FtcGxlU3ludGhldGljS2V5".repeat(LONG_FIXTURE ? 12 : 4)}IDAQAB`;

export function SampleBanner({ children }: { children?: ReactNode }) {
	return (
		<Alert variant="info" title="Sample data">
			{children ?? "Everything on this screen is made up for the design gallery. No real domain was looked up."}
		</Alert>
	);
}

export const SampleBadge = () => <Badge variant="outline">Sample</Badge>;
