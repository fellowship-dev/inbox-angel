import {
	AppShell,
	Badge,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	IconButton,
	LogoMark,
	type RenderNavLink,
} from '@inbox-angel/ui';
import { Globe, History, KeyRound, LogOut, Mail, Moon, Settings, Sun, UserCircle, Users } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { useTheme } from '../lib/theme';
import { useSession } from '../lib/session';
import { Banners } from './Banners';

const renderLink: RenderNavLink = ({ href, ...rest }) => <Link to={href} {...rest} />;

function isCurrent(path: string, item: string): boolean {
	if (item === '/') return path === '/' || path === '/add' || path.startsWith('/domains') || path === '/bulk-import' || path === '/ct-discover';
	return path === item || path.startsWith(`${item}/`);
}

export function Shell() {
	const { pathname } = useLocation();
	const { me, role, signOut } = useSession();
	const { theme, toggle } = useTheme();
	const items = [
		{ label: 'Domains', href: '/', icon: <Globe /> },
		{ label: 'Email check', href: '/check', icon: <Mail /> },
		{ label: 'Team', href: '/team', icon: <Users /> },
		{ label: 'API keys', href: '/keys', icon: <KeyRound /> },
		{ label: 'Audit log', href: '/audit', icon: <History /> },
		{ label: 'Settings', href: '/settings', icon: <Settings /> },
	].map((i) => ({ ...i, current: isCurrent(pathname, i.href) }));

	return (
		<AppShell
			brand={
				<Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
					<LogoMark className="size-8 shrink-0" aria-hidden />
					<span>Inbox Angel</span>
				</Link>
			}
			nav={[{ items }]}
			renderLink={renderLink}
			topbarEnd={
				<>
					<IconButton label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
						{theme === 'dark' ? <Sun aria-hidden /> : <Moon aria-hidden />}
					</IconButton>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<IconButton label="Account menu">
								<UserCircle aria-hidden />
							</IconButton>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuLabel className="space-y-1">
								<span className="block max-w-56 truncate text-sm font-medium text-ink-1">{me?.user?.email ?? 'Instance key'}</span>
								{role ? <Badge variant="brand">{role}</Badge> : null}
							</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => void signOut()}>
								<LogOut aria-hidden />
								Sign out
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</>
			}
		>
			<Banners />
			<Outlet />
		</AppShell>
	);
}
