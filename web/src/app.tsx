import { Button, EmptyState, Toaster } from '@inbox-angel/ui';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router';
import { FocusLayout } from './components/FocusLayout';
import { Shell } from './components/Shell';
import { PageSkeleton } from './components/states';
import { SessionProvider, useSession } from './lib/session';
import { AuthPage } from './pages/auth/AuthPage';
import { ForgotPage } from './pages/auth/ForgotPage';
import { InvitePage } from './pages/auth/InvitePage';
import { ResetPage } from './pages/auth/ResetPage';

/** Waits for the session, then shows the app, the sign-in screen (deep link preserved) or a "server unreachable" state. */
function Gate({ children }: { children: ReactNode }) {
	const { state, retry } = useSession();
	if (state === 'loading') return <div className="mx-auto max-w-2xl p-8"><PageSkeleton label="Starting up" /></div>;
	if (state === 'unreachable') {
		return (
			<div className="mx-auto max-w-lg p-8">
				<EmptyState
					title="Waiting for the server"
					description="Inbox Angel did not answer. On the very first start it runs database migrations, which can take a minute."
					action={<Button onClick={retry}>Try again</Button>}
				/>
			</div>
		);
	}
	if (state === 'anon') return <AuthPage />;
	return <>{children}</>;
}

/**
 * Fresh instances have no domain: send owners and admins to the setup wizard once per tab.
 * Once, because "Skip setup" is a choice: bouncing people back every time they open Domains is not help.
 */
function SetupRedirect({ children }: { children: ReactNode }) {
	const { status, canWrite } = useSession();
	const { pathname } = useLocation();
	if (status && status.has_domain === false && canWrite && pathname === '/' && !sessionStorage.getItem(SETUP_SEEN)) {
		sessionStorage.setItem(SETUP_SEEN, '1');
		return <Navigate to="/setup" replace />;
	}
	return <>{children}</>;
}
const SETUP_SEEN = 'ia_setup_redirected';

function NotFound() {
	return <EmptyState title="Page not found" description="That page does not exist." action={<Button asChild><a href="#/">Back to domains</a></Button>} />;
}

/** Validates `:id` once so pages can take a number. */
export function useDomainId(): number {
	const { id } = useParams();
	return Number.parseInt(id ?? '', 10);
}

function Wizard({ children, exitTo = '/' }: { children: ReactNode; exitTo?: string }) {
	return <FocusLayout exitTo={exitTo}>{children}</FocusLayout>;
}

function WizardFor({ render }: { render: (domainId: number) => ReactNode }) {
	const id = useDomainId();
	if (Number.isNaN(id)) return <NotFound />;
	return <Wizard exitTo={`/domains/${id}`}>{render(id)}</Wizard>;
}

// Every page is its own chunk: the sign-in screen and shell load first, pages load on navigation.
const AnalyticsPage = lazy(() => import('./pages/analytics/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));
const DomainAnalyticsPage = lazy(() => import('./pages/analytics/AnalyticsPage').then((m) => ({ default: m.DomainAnalyticsPage })));
const AnomaliesPage = lazy(() => import('./pages/reports/AnomaliesPage').then((m) => ({ default: m.AnomaliesPage })));
const AuditLogPage = lazy(() => import('./pages/audit/AuditLogPage').then((m) => ({ default: m.AuditLogPage })));
const ApiKeysPage = lazy(() => import('./pages/keys/ApiKeysPage').then((m) => ({ default: m.ApiKeysPage })));
const EmailCheckPage = lazy(() => import('./pages/check/EmailCheckPage').then((m) => ({ default: m.EmailCheckPage })));
const AddDomainPage = lazy(() => import('./pages/domains/AddDomainPage').then((m) => ({ default: m.AddDomainPage })));
const BulkImportPage = lazy(() => import('./pages/domains/BulkImportPage').then((m) => ({ default: m.BulkImportPage })));
const CtDiscoverPage = lazy(() => import('./pages/domains/CtDiscoverPage').then((m) => ({ default: m.CtDiscoverPage })));
const DomainDetailPage = lazy(() => import('./pages/domains/DomainDetailPage').then((m) => ({ default: m.DomainDetailPage })));
const DomainSettingsPage = lazy(() => import('./pages/domains/DomainSettingsPage').then((m) => ({ default: m.DomainSettingsPage })));
const OverviewPage = lazy(() => import('./pages/domains/OverviewPage').then((m) => ({ default: m.OverviewPage })));
const ExplorePage = lazy(() => import('./pages/reports/ExplorePage').then((m) => ({ default: m.ExplorePage })));
const ReportBrowserPage = lazy(() => import('./pages/reports/ReportBrowserPage').then((m) => ({ default: m.ReportBrowserPage })));
const ReportDetailPage = lazy(() => import('./pages/reports/ReportDetailPage').then((m) => ({ default: m.ReportDetailPage })));
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const TeamPage = lazy(() => import('./pages/team/TeamPage').then((m) => ({ default: m.TeamPage })));
const DmarcWizardPage = lazy(() => import('./pages/wizards/DmarcWizardPage').then((m) => ({ default: m.DmarcWizardPage })));
const MtaStsPage = lazy(() => import('./pages/wizards/MtaStsPage').then((m) => ({ default: m.MtaStsPage })));
const SetupWizardPage = lazy(() => import('./pages/wizards/SetupWizardPage').then((m) => ({ default: m.SetupWizardPage })));
const SpfFlattenPage = lazy(() => import('./pages/wizards/SpfFlattenPage').then((m) => ({ default: m.SpfFlattenPage })));

// Hash routes on purpose: reset and invite emails, and bookmarks, already use `#/…`.
function AppRoutes() {
	return (
		<Suspense fallback={<div className="mx-auto max-w-3xl p-8"><PageSkeleton /></div>}>
		<Routes>
			<Route path="/invite/:token" element={<InvitePage />} />
			<Route path="/reset/:token" element={<ResetPage />} />
			<Route path="/forgot" element={<ForgotPage />} />
			<Route
				element={
					<Gate>
						<SetupRedirect>
							<Shell />
						</SetupRedirect>
					</Gate>
				}
			>
				<Route index element={<OverviewPage />} />
				<Route path="login" element={<Navigate to="/" replace />} />
				<Route path="add" element={<AddDomainPage />} />
				<Route path="bulk-import" element={<BulkImportPage />} />
				<Route path="ct-discover" element={<CtDiscoverPage />} />
				<Route path="analytics" element={<AnalyticsPage />} />
				<Route path="check" element={<EmailCheckPage />} />
				<Route path="team" element={<TeamPage />} />
				<Route path="keys" element={<ApiKeysPage />} />
				<Route path="audit" element={<AuditLogPage />} />
				<Route path="settings" element={<SettingsPage />} />
				<Route path="domains/:id" element={<DomainDetailPage />} />
				<Route path="domains/:id/settings" element={<DomainSettingsPage />} />
				<Route path="domains/:id/analytics" element={<DomainAnalyticsPage />} />
				<Route path="domains/:id/explore" element={<ExplorePage />} />
				<Route path="domains/:id/anomalies" element={<AnomaliesPage />} />
				<Route path="domains/:id/reports" element={<ReportBrowserPage />} />
				<Route path="domains/:id/reports/:date" element={<ReportDetailPage />} />
				<Route path="*" element={<NotFound />} />
			</Route>
			{/* Wizards: full-screen, no sidebar */}
			<Route element={<Gate><Outlet /></Gate>}>
				<Route path="setup" element={<Wizard><SetupWizardPage /></Wizard>} />
				<Route path="onboarding" element={<Navigate to="/setup" replace />} />
				<Route path="domains/:id/setup" element={<WizardFor render={() => <SetupWizardPage />} />} />
				<Route path="domains/:id/setup/:step" element={<WizardFor render={() => <SetupWizardPage />} />} />
				<Route path="domains/:id/spf-flatten" element={<WizardFor render={() => <SpfFlattenPage />} />} />
				<Route path="domains/:id/mta-sts" element={<WizardFor render={() => <MtaStsPage />} />} />
				<Route path="domains/:id/dmarc-wizard" element={<WizardFor render={() => <DmarcWizardPage />} />} />
			</Route>
		</Routes>
		</Suspense>
	);
}

export function App({ queryClient, Router = HashRouter }: { queryClient: QueryClient; Router?: ComponentType<{ children: ReactNode }> }) {
	return (
		<QueryClientProvider client={queryClient}>
			<SessionProvider>
				<Router>
					<AppRoutes />
				</Router>
				<Toaster />
			</SessionProvider>
		</QueryClientProvider>
	);
}
