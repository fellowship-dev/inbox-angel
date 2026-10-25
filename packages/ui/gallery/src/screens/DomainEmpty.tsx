import { AppShell, Button, EmptyState, IconButton, LogoMark, PageHeader, type NavSection } from "@inbox-angel/ui";
import { Bell, FileText, Globe, LayoutDashboard, Plus, Settings, User } from "lucide-react";

const nav: NavSection[] = [
	{
		items: [
			{ label: "Overview", href: "#/overview-empty", icon: <LayoutDashboard />, current: true },
			{ label: "Domains", href: "#/overview-empty", icon: <Globe /> },
			{ label: "Reports", href: "#/overview-empty", icon: <FileText /> },
			{ label: "Alerts", href: "#/overview-empty", icon: <Bell /> },
		],
	},
	{ label: "Account", items: [{ label: "Settings", href: "#/overview-empty", icon: <Settings /> }] },
];

/** First-run dashboard: no domain yet. One next step. */
export function DomainEmpty() {
	return (
		<AppShell
			brand={
				<>
					<LogoMark className="size-8 shrink-0 rounded-md" />
					<span className="truncate text-base font-bold tracking-tight">Inbox Angel</span>
				</>
			}
			nav={nav}
			sidebarFooter="Sample build"
			topbarStart={<span className="truncate text-sm text-ink-2">Domains</span>}
			topbarEnd={<IconButton label="Account menu" variant="secondary"><User aria-hidden /></IconButton>}
		>
			<PageHeader
				title="Domains"
				description="Is signup and password-reset email authenticated, and what is left to fix?"
				actions={<Button><Plus aria-hidden />Add domain</Button>}
			/>
			<EmptyState
				icon={<Globe />}
				title="No domains yet"
				description="Add the domain you send email from. We look up SPF, DKIM and DMARC and tell you what to fix first."
				action={<Button><Plus aria-hidden />Add your first domain</Button>}
			/>
		</AppShell>
	);
}
