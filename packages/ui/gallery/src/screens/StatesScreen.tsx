import { Alert, AppShell, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, CheckResult, CheckResultList, IconButton, LogoMark, PageHeader, Skeleton, type NavSection } from "@inbox-angel/ui";
import { FileText, Globe, LayoutDashboard, RefreshCw, User } from "lucide-react";
import { useState } from "react";
import { SAMPLE_DOMAIN } from "../sample";

const nav: NavSection[] = [
	{
		items: [
			{ label: "Overview", href: "#/loading", icon: <LayoutDashboard />, current: true },
			{ label: "Domains", href: "#/loading", icon: <Globe /> },
			{ label: "Reports", href: "#/loading", icon: <FileText /> },
		],
	},
];

/** Loading skeleton and a retryable lookup failure, on the real shell. `initial` picks the starting state. */
export function StatesScreen({ initial }: { initial: "loading" | "error" }) {
	const [state, setState] = useState<"loading" | "error" | "ok">(initial);
	const retry = () => {
		setState("loading");
		setTimeout(() => setState("error"), 1200);
	};
	return (
		<AppShell
			brand={
				<>
					<LogoMark className="size-8 shrink-0 rounded-md" />
					<span className="truncate text-base font-bold tracking-tight">Inbox Angel</span>
				</>
			}
			nav={nav}
			topbarStart={<span className="truncate font-mono text-sm text-ink-1">{SAMPLE_DOMAIN}</span>}
			topbarEnd={<IconButton label="Account menu" variant="secondary"><User aria-hidden /></IconButton>}
		>
			<PageHeader title="Domain overview" description="Checks run against live DNS. Nothing here is a real lookup." />
			{state === "loading" ? (
				<div aria-busy="true" aria-label="Loading checks" role="status" className="space-y-6">
					<Card>
						<CardHeader>
							<Skeleton className="h-5 w-40" />
							<Skeleton className="h-4 w-3/4 max-w-md" />
						</CardHeader>
						<CardContent className="space-y-3">
							<Skeleton className="h-4 w-full" />
							<Skeleton className="h-4 w-5/6" />
							<Skeleton className="h-4 w-2/3" />
						</CardContent>
					</Card>
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : (
				<div className="space-y-6">
					<Alert variant="danger" title="We could not reach DNS for this domain">
						<p>The lookup timed out. Your records were not changed. Try again in a moment.</p>
						<div className="pt-2">
							<Button size="sm" variant="secondary" onClick={retry}><RefreshCw aria-hidden />Try again</Button>
						</div>
					</Alert>
					<CheckResultList>
						<CheckResult status="error" title="SPF" onRetry={retry} />
						<CheckResult status="error" title="DKIM" onRetry={retry} />
						<CheckResult status="pass" title="DMARC" summary="Policy is none. Move to quarantine once reports look clean." />
					</CheckResultList>
				</div>
			)}
		</AppShell>
	);
}
