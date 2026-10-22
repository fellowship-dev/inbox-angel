import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

export interface NavItem {
	label: string;
	href: string;
	icon?: React.ReactNode;
	current?: boolean;
	/** Small trailing text, e.g. a count. */
	badge?: React.ReactNode;
}
export interface NavSection {
	label?: string;
	items: NavItem[];
}

export type RenderNavLink = (props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => React.ReactElement;
const defaultRenderLink: RenderNavLink = (props) => <a {...props} />;

export interface AppShellProps {
	/** Product mark + name, shown at the top of the sidebar. */
	brand: React.ReactNode;
	nav: NavSection[];
	/** Left side of the top bar (breadcrumb, domain switcher). */
	topbarStart?: React.ReactNode;
	/** Right side of the top bar (theme toggle, account menu). */
	topbarEnd?: React.ReactNode;
	/** Pinned to the bottom of the sidebar. */
	sidebarFooter?: React.ReactNode;
	collapsed?: boolean;
	defaultCollapsed?: boolean;
	onCollapsedChange?: (collapsed: boolean) => void;
	/** Mobile drawer open state (uncontrolled when omitted). */
	mobileOpen?: boolean;
	onMobileOpenChange?: (open: boolean) => void;
	/** Plug in a router link component. Defaults to <a>. */
	renderLink?: RenderNavLink;
	className?: string;
	children: React.ReactNode;
}

function NavList({
	nav,
	collapsed,
	renderLink,
	onNavigate,
}: {
	nav: NavSection[];
	collapsed: boolean;
	renderLink: RenderNavLink;
	onNavigate?: () => void;
}) {
	return (
		<nav aria-label="Main" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
			{nav.map((section, i) => (
				<div key={section.label ?? i} className="space-y-1">
					{section.label ? (
						<p className={cn("px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-2", collapsed && "sr-only")}>{section.label}</p>
					) : null}
					<ul className="space-y-0.5">
						{section.items.map((item) => {
							const link = renderLink({
								href: item.href,
								"aria-current": item.current ? "page" : undefined,
								onClick: onNavigate,
								className: cn(
									"flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors [&_svg]:size-5 [&_svg]:shrink-0",
									item.current ? "bg-brand-subtle text-brand-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
									collapsed && "justify-center px-0",
								),
								children: (
									<>
										{item.icon ? <span aria-hidden className="contents">{item.icon}</span> : null}
										<span className={cn("min-w-0 flex-1 truncate", collapsed && "sr-only")}>{item.label}</span>
										{item.badge && !collapsed ? <span className="text-xs text-ink-2">{item.badge}</span> : null}
									</>
								),
							});
							return (
								<li key={item.href}>
									{collapsed ? (
										<Tooltip>
											<TooltipTrigger asChild>{link}</TooltipTrigger>
											<TooltipContent side="right">{item.label}</TooltipContent>
										</Tooltip>
									) : (
										link
									)}
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</nav>
	);
}

/**
 * App chrome: collapsible sidebar (md+), top bar, and a drawer on small screens.
 * Landmarks: header, nav "Main", main#main-content, plus a skip link.
 */
export function AppShell({
	brand,
	nav,
	topbarStart,
	topbarEnd,
	sidebarFooter,
	collapsed: collapsedProp,
	defaultCollapsed = false,
	onCollapsedChange,
	mobileOpen: mobileOpenProp,
	onMobileOpenChange,
	renderLink = defaultRenderLink,
	className,
	children,
}: AppShellProps) {
	const [collapsedState, setCollapsedState] = React.useState(defaultCollapsed);
	const [mobileState, setMobileState] = React.useState(false);
	const collapsed = collapsedProp ?? collapsedState;
	const mobileOpen = mobileOpenProp ?? mobileState;
	const setCollapsed = (v: boolean) => {
		setCollapsedState(v);
		onCollapsedChange?.(v);
	};
	const setMobileOpen = (v: boolean) => {
		setMobileState(v);
		onMobileOpenChange?.(v);
	};

	return (
		<TooltipProvider>
			<div className={cn("min-h-screen bg-surface-0 text-ink-1 md:flex", className)}>
				<a
					href="#main-content"
					className="sr-only z-[200] rounded-md bg-brand px-4 py-2 font-medium text-brand-fg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
				>
					Skip to content
				</a>

				{/* Desktop sidebar */}
				<aside
					data-collapsed={collapsed}
					className={cn(
						"sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface-1 transition-[width] duration-200 md:flex",
						collapsed ? "w-16" : "w-64",
					)}
				>
					<div className={cn("flex h-16 shrink-0 items-center border-b border-line px-4", collapsed && "justify-center px-0")}>
						<div className={cn("flex min-w-0 items-center gap-2", collapsed && "[&>*:not(:first-child)]:sr-only")}>{brand}</div>
					</div>
					<NavList nav={nav} collapsed={collapsed} renderLink={renderLink} />
					<div className={cn("flex items-center gap-2 border-t border-line p-3", collapsed ? "flex-col" : "justify-between")}>
						{!collapsed ? <div className="min-w-0 flex-1 text-sm text-ink-2">{sidebarFooter}</div> : null}
						<IconButton
							label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
							aria-expanded={!collapsed}
							onClick={() => setCollapsed(!collapsed)}
						>
							{collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
						</IconButton>
					</div>
				</aside>

				{/* Mobile drawer */}
				<DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
					<DialogPrimitive.Portal>
						<DialogPrimitive.Overlay className="ia-fade-in fixed inset-0 z-40 bg-ink-1/50 md:hidden" />
						<DialogPrimitive.Content
							aria-describedby={undefined}
							className="ia-slide-left fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface-1 text-ink-1 shadow-float md:hidden"
						>
							<DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
							<div className="flex h-16 shrink-0 items-center justify-between border-b border-line px-4">
								<div className="flex min-w-0 items-center gap-2">{brand}</div>
								<DialogPrimitive.Close asChild>
									<IconButton label="Close navigation">
										<X aria-hidden />
									</IconButton>
								</DialogPrimitive.Close>
							</div>
							<NavList nav={nav} collapsed={false} renderLink={renderLink} onNavigate={() => setMobileOpen(false)} />
							{sidebarFooter ? <div className="border-t border-line p-4 text-sm text-ink-2">{sidebarFooter}</div> : null}
						</DialogPrimitive.Content>
					</DialogPrimitive.Portal>
				</DialogPrimitive.Root>

				<div className="flex min-w-0 flex-1 flex-col">
					<header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b border-line bg-surface-1/95 px-4 backdrop-blur sm:px-6">
						<IconButton className="md:hidden" label="Open navigation" aria-haspopup="dialog" onClick={() => setMobileOpen(true)}>
							<Menu aria-hidden />
						</IconButton>
						<div className="flex min-w-0 flex-1 items-center gap-2">{topbarStart}</div>
						<div className="flex shrink-0 items-center gap-2">{topbarEnd}</div>
					</header>
					<main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-4 py-6 sm:px-6 sm:py-8">
						{children}
					</main>
				</div>
			</div>
		</TooltipProvider>
	);
}
