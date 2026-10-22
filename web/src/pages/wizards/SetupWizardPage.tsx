import { Button, toast } from '@inbox-angel/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { LoadError, PageSkeleton, ReadOnlyNotice } from '../../components/states';
import { WizardProgress } from '../../components/wizard/WizardProgress';
import { api } from '../../lib/api';
import { keys, useDomains } from '../../lib/queries';
import { useSession } from '../../lib/session';
import type { WizardState, WizardStepState } from '../../lib/types';
import { DkimStep } from './setup/DkimStep';
import { DmarcStep } from './setup/DmarcStep';
import { DomainStep } from './setup/DomainStep';
import { setupKeys, useOnboardingStatus, useWizardState } from './setup/hooks';
import { RoutingStep } from './setup/RoutingStep';
import { SpfStep } from './setup/SpfStep';
import { DEFAULT_WIZARD, STEP_COUNT, STEP_KEYS, STEP_LABELS, completedCount, parseStep, resolveStep } from './setup/steps';

/**
 * `#/setup` (no domain yet) and `#/domains/:id/setup[/:step]`. The step lives in the URL, 1-indexed, so
 * reload, back and bookmarks all work; the persisted wizard state only decides where to resume.
 */
export function SetupWizardPage() {
	const { id, step } = useParams();
	if (id === undefined) return <EntryFlow />;
	return <DomainSetup domainId={Number.parseInt(id, 10)} urlStep={parseStep(step)} />;
}

function Frame({ title, subtitle, skipTo, wizard, current, children }: { title: ReactNode; subtitle: string; skipTo: string; wizard: WizardState; current: number; children: ReactNode }) {
	return (
		<div className="space-y-6">
			<header className="space-y-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<h1 className="text-2xl font-bold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
						<p className="text-sm text-ink-2">{subtitle}</p>
					</div>
					<Button asChild variant="ghost" size="sm" className="shrink-0">
						<Link to={skipTo}>Skip setup</Link>
					</Button>
				</div>
				<WizardProgress
					label="Setup progress"
					current={current}
					steps={STEP_LABELS.map((label, i) => ({
						label,
						state: wizard[STEP_KEYS[i] ?? 'domain'] === 'complete' ? 'complete' : wizard[STEP_KEYS[i] ?? 'domain'] === 'skipped' ? 'skipped' : 'pending',
					}))}
				/>
			</header>
			<ReadOnlyNotice />
			{children}
		</div>
	);
}

/** No domain id in the URL: if a domain exists, continue with the first one; if not, this is a fresh instance. */
function EntryFlow() {
	const domains = useDomains();
	const qc = useQueryClient();
	const navigate = useNavigate();

	if (domains.isPending) return <PageSkeleton label="Checking for domains" />;
	if (domains.isError) return <LoadError error={domains.error} onRetry={() => void domains.refetch()} title="Could not check your domains" />;
	const first = domains.data[0];
	if (first) return <Navigate to={`/domains/${first.id}/setup/1`} replace />;

	return (
		<Frame title="Let's set up Inbox Angel" subtitle="0 of 5 steps complete" skipTo="/" wizard={DEFAULT_WIZARD} current={0}>
			<DomainStep
				onDomainSet={(newId) => {
					void qc.invalidateQueries({ queryKey: keys.domains });
					void qc.invalidateQueries({ queryKey: ['auth-status'] });
					navigate(`/domains/${newId}/setup/2`);
				}}
			/>
		</Frame>
	);
}

function DomainSetup({ domainId, urlStep }: { domainId: number; urlStep: number | null }) {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { canWrite } = useSession();
	const statusQ = useOnboardingStatus(domainId);
	const wizardQ = useWizardState(domainId);
	const domainMarked = useRef(false);

	// The domain exists, so its step is complete. Persist that once (only writers can) and show it either way.
	useEffect(() => {
		const w = wizardQ.data;
		if (!w || w.domain === 'complete' || domainMarked.current) return;
		domainMarked.current = true;
		qc.setQueryData<WizardState>(setupKeys.wizard(domainId), { ...w, domain: 'complete' });
		if (canWrite) void api(`/api/domains/${domainId}/wizard-state`, { method: 'PUT', body: { domain: 'complete' } }).catch(() => {});
	}, [wizardQ.data, canWrite, domainId, qc]);

	if (statusQ.isPending || wizardQ.isPending) return <PageSkeleton label="Checking your domain" />;
	if (statusQ.isError) {
		return (
			<div className="space-y-4">
				<LoadError error={statusQ.error} onRetry={() => void statusQ.refetch()} title="Could not load the status of this domain" />
				<Button asChild variant="secondary">
					<Link to="/">Go to dashboard</Link>
				</Button>
			</div>
		);
	}

	const status = statusQ.data;
	const wizard = wizardQ.data ?? DEFAULT_WIZARD;
	const resolved = resolveStep(urlStep, wizard);
	if (resolved !== urlStep) return <Navigate to={`/domains/${domainId}/setup/${resolved}`} replace />;

	const index = resolved - 1;
	const done = () => navigate(`/domains/${domainId}`);

	function finish(state: WizardStepState) {
		const key = STEP_KEYS[index];
		if (!key) return;
		qc.setQueryData<WizardState>(setupKeys.wizard(domainId), { ...wizard, [key]: state });
		// Members may walk through the steps but cannot save progress; the API would refuse it.
		if (canWrite) {
			api(`/api/domains/${domainId}/wizard-state`, { method: 'PUT', body: { [key]: state } }).catch(() =>
				toast({ variant: 'warning', title: 'Progress not saved', description: 'You can keep going; this step may show as unfinished next time.' }),
			);
		}
		if (index < STEP_COUNT - 1) navigate(`/domains/${domainId}/setup/${index + 2}`);
		else done();
	}

	const props = {
		status,
		onNext: () => finish('complete'),
		onSkip: () => finish('skipped'),
		onRetry: () => void statusQ.refetch(),
		retrying: statusQ.isFetching,
	};

	return (
		<Frame
			title={
				<>
					Let's verify your email security for <span className="text-brand-ink">{status.domain}</span>
				</>
			}
			subtitle={`${completedCount(wizard)} of ${STEP_COUNT} steps complete`}
			skipTo={`/domains/${domainId}`}
			wizard={wizard}
			current={index}
		>
			{index === 1 ? <SpfStep {...props} /> : null}
			{index === 2 ? <DkimStep {...props} /> : null}
			{index === 3 ? <DmarcStep {...props} /> : null}
			{index === 4 ? <RoutingStep {...props} /> : null}
		</Frame>
	);
}
