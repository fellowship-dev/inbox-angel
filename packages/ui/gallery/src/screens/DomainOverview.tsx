import {
	AppShell, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, CheckResult, CheckResultList, DropdownMenu,
	DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, IconButton, LevelCard,
	LogoMark, PageHeader, RecordBlock, Stat, StatGroup, toast, type NavSection,
} from "@inbox-angel/ui";
import { Bell, FileText, Globe, LayoutDashboard, Plus, RefreshCw, Settings, User } from "lucide-react";
import { SAMPLE_DOMAIN, SampleBanner } from "../sample";

const nav: NavSection[] = [
	{
		items: [
			{ label: "Overview", href: "#/overview", icon: <LayoutDashboard />, current: true },
			{ label: "Domains", href: "#/overview", icon: <Globe />, badge: "1" },
			{ label: "Reports", href: "#/overview", icon: <FileText /> },
			{ label: "Alerts", href: "#/overview", icon: <Bell /> },
		],
	},
	{ label: "Account", items: [{ label: "Settings", href: "#/overview", icon: <Settings /> }] },
];

export function DomainOverview() {
	return (
		<AppShell
			brand={
				<>
					<LogoMark className="h-7 w-auto shrink-0 text-ink-1" />
					<span className="truncate text-base font-bold tracking-tight">Inbox Angel</span>
				</>
			}
			nav={nav}
			sidebarFooter="Sample build"
			topbarStart={
				<nav aria-label="Breadcrumb" className="truncate text-sm text-ink-2">
					Domains <span aria-hidden>/</span> <span className="font-mono text-ink-1">{SAMPLE_DOMAIN}</span>
				</nav>
			}
			topbarEnd={
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<IconButton label="Account menu" variant="secondary"><User aria-hidden /></IconButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel>Sample account</DropdownMenuLabel>
						<DropdownMenuItem>Settings</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem>Sign out</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			}
		>
			<PageHeader
				title="Domain overview"
				description="Is signup and password-reset email authenticated, and what is left to fix?"
				actions={
					<>
						<Button variant="secondary" onClick={() => toast({ title: "Checks re-run", description: "Sample action, nothing was looked up.", variant: "success" })}>
							<RefreshCw aria-hidden />Re-run checks
						</Button>
						<Button><Plus aria-hidden />Add domain</Button>
					</>
				}
			/>
			<SampleBanner>Domain, numbers and records on this screen are made up to show the layout.</SampleBanner>

			<div className="grid gap-6 lg:grid-cols-5">
				<LevelCard
					className="lg:col-span-3"
					level={1}
					domain={SAMPLE_DOMAIN}
					description="Your mail is authenticated: receivers can verify who sent it. It is not yet protected against spoofing."
					findings={[
						{ status: "pass", label: "SPF passes for your sending service" },
						{ status: "pass", label: "DKIM signs outgoing mail" },
						{ status: "warn", label: "DMARC is monitoring only (p=none)", detail: "Spoofed mail is still delivered." },
						{ status: "missing", label: "No MTA-STS policy" },
					]}
				>
					<p className="border-t border-line pt-4 text-sm text-ink-2">
						Authentication is something we can fix this week. Whether a message lands in the inbox also depends on your sending reputation, which takes weeks and is not guaranteed.
					</p>
				</LevelCard>
				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle>Last 7 days</CardTitle>
						<CardDescription>Aggregate reports received</CardDescription>
					</CardHeader>
					<CardContent>
						<StatGroup className="sm:grid-cols-1 min-[420px]:grid-cols-3 lg:grid-cols-1">
							<Stat sample label="Messages" value="1,234" delta={{ value: "+4%", direction: "up", good: true }} deltaLabel="vs. prior week" />
							<Stat sample label="Failing DMARC" value="12" delta={{ value: "3 more", direction: "up", good: false }} />
							<Stat sample label="Sending sources" value="7" delta={{ value: "no change", direction: "flat" }} />
						</StatGroup>
					</CardContent>
				</Card>
			</div>

			<section aria-labelledby="checks-h" className="space-y-3">
				<h2 id="checks-h" className="text-lg font-semibold tracking-tight">Checks</h2>
				<CheckResultList>
					<CheckResult status="pass" title="SPF" summary="One record, 4 of 10 DNS lookups used." />
					<CheckResult status="pass" title="DKIM" summary="Selector sample1 found, 2048-bit key." />
					<CheckResult status="warn" title="DMARC" summary="Policy is none. Move to quarantine once reports look clean." />
					<CheckResult status="missing" title="MTA-STS" summary="No _mta-sts record. Optional, but it protects mail in transit." />
					<CheckResult status="error" title="BIMI" onRetry={() => toast({ title: "Retrying", description: "Sample action.", variant: "info" })} />
				</CheckResultList>
			</section>

			<section aria-labelledby="fix-h" className="space-y-3">
				<h2 id="fix-h" className="text-lg font-semibold tracking-tight">Next step</h2>
				<p className="max-w-prose text-sm text-ink-2">Publish this record at your DNS provider to start receiving reports. Copy each field into your provider's form.</p>
				<RecordBlock title="Sample record" record={{ type: "TXT", name: "_dmarc", value: `v=DMARC1; p=none; rua=mailto:reports@${SAMPLE_DOMAIN}`, ttl: "Auto" }} />
			</section>
		</AppShell>
	);
}
