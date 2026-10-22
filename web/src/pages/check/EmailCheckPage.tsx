import { Button, EmptyState, IconButton, PageHeader, cn, toast } from '@inbox-angel/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, Mail, MailQuestion } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BackLink, OverallBadge, ProtocolChip, ProtocolResults } from '../../components/reports';
import { ListSkeleton, LoadError, Section } from '../../components/states';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { CHECK_GIVE_UP_MS, CHECK_POLL_MS } from '../../lib/reports';
import type { CheckResult } from '../../lib/types';

interface CheckSession {
	token: string;
	email: string;
}

type Phase =
	| { kind: 'idle' }
	| { kind: 'creating' }
	| { kind: 'waiting'; session: CheckSession }
	| { kind: 'timeout'; session: CheckSession }
	| { kind: 'done'; result: CheckResult }
	| { kind: 'error'; error: unknown };

const HISTORY_KEY = ['check-results'] as const;

function CopyAddress({ email }: { email: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	async function copy() {
		try {
			await navigator.clipboard.writeText(email);
			setCopied(true);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			toast({ variant: 'warning', title: 'Could not copy', description: 'Select the address and copy it by hand.' });
		}
	}
	return (
		<div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-2 pl-4 pr-2">
			<code className="min-w-0 flex-1 font-mono text-sm text-ink-1 [overflow-wrap:anywhere]" data-testid="check-address">
				{email}
			</code>
			<IconButton label="Copy address" variant="secondary" onClick={() => void copy()}>
				{copied ? <Check aria-hidden className="text-success" /> : <Copy aria-hidden />}
			</IconButton>
			<span role="status" className="sr-only">
				{copied ? 'Copied to clipboard' : ''}
			</span>
		</div>
	);
}

function Waiting({ session, onCancel }: { session: CheckSession; onCancel: () => void }) {
	return (
		<div className="max-w-xl space-y-4">
			<p className="text-ink-1">Send any email from the domain you want to audit to this address:</p>
			<CopyAddress email={session.email} />
			<p role="status" className="flex items-center gap-2 text-sm text-ink-2">
				<span aria-hidden className="size-2.5 rounded-full bg-brand-ink motion-safe:animate-pulse" />
				Waiting for email… (checking every {CHECK_POLL_MS / 1000}s)
			</p>
			<p className="text-sm text-ink-2">
				You can use any email client or the <code className="font-mono">curl</code> / <code className="font-mono">swaks</code> command line. The result appears the moment we receive and process it.
			</p>
			<Button variant="secondary" onClick={onCancel}>
				Cancel
			</Button>
		</div>
	);
}

function HistoryRow({ r, expanded, onToggle }: { r: CheckResult; expanded: boolean; onToggle: () => void }) {
	const panel = `check-${r.id}`;
	return (
		<li className="border-b border-line last:border-0">
			<button
				type="button"
				aria-expanded={expanded}
				aria-controls={panel}
				onClick={onToggle}
				className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-2/60 md:grid-cols-[minmax(0,12rem)_auto_minmax(0,1fr)_auto_auto]"
			>
				<span className="min-w-0 font-semibold text-ink-1 [overflow-wrap:anywhere]">{r.from_domain}</span>
				<span className="justify-self-end md:justify-self-start">
					<OverallBadge status={r.overall_status} />
				</span>
				<span className="col-span-2 flex flex-wrap gap-x-3 gap-y-1 md:col-span-1">
					<ProtocolChip name="SPF" result={r.spf_result} />
					<ProtocolChip name="DKIM" result={r.dkim_result} />
					<ProtocolChip name="DMARC" result={r.dmarc_result} />
				</span>
				<span className="text-xs text-ink-2 md:text-right">{formatDateTime(r.created_at)}</span>
				<ChevronDown aria-hidden className={cn('size-4 text-ink-2 transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
				<span className="sr-only">{expanded ? 'Hide results' : 'Show results'}</span>
			</button>
			{expanded ? (
				<div id={panel} className="px-4 pb-4">
					<p className="mb-2 text-xs text-ink-2">Sent from {r.from_email}</p>
					<ProtocolResults result={r} />
				</div>
			) : null}
		</li>
	);
}

function History({ expandedId, setExpandedId }: { expandedId: number | null; setExpandedId: (id: number | null) => void }) {
	const q = useQuery({ queryKey: HISTORY_KEY, queryFn: () => api<{ results: CheckResult[] }>('/api/check-results').then((r) => r.results) });
	return (
		<Section title="Recent checks">
			{q.isPending ? (
				<ListSkeleton rows={2} label="Loading recent checks" />
			) : q.isError ? (
				<LoadError error={q.error} onRetry={() => void q.refetch()} title="Could not load recent checks" />
			) : q.data.length === 0 ? (
				<EmptyState icon={<Mail />} title="No checks yet" description="Run your first check above. Each result is kept here so you can compare after fixing something." />
			) : (
				<>
					<div className="hidden grid-cols-[minmax(0,12rem)_auto_minmax(0,1fr)_auto_auto] gap-x-4 px-4 text-xs font-semibold uppercase tracking-wide text-ink-2 md:grid" aria-hidden>
						<span>Domain</span>
						<span>Status</span>
						<span>Results</span>
						<span>Checked</span>
						<span className="w-4" />
					</div>
					<ul className="overflow-hidden rounded-lg border border-line bg-surface-1">
						{q.data.map((r) => (
							<HistoryRow key={r.id} r={r} expanded={expandedId === r.id} onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)} />
						))}
					</ul>
				</>
			)}
		</Section>
	);
}

export function EmailCheckPage() {
	const qc = useQueryClient();
	const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
	const [expandedId, setExpandedId] = useState<number | null>(null);

	const start = useCallback(async () => {
		setPhase({ kind: 'creating' });
		try {
			const session = await api<CheckSession>('/api/check-sessions', { method: 'POST' });
			setPhase({ kind: 'waiting', session });
		} catch (error) {
			// A failed request (429, offline) is not a failed check.
			setPhase({ kind: 'error', error });
		}
	}, []);

	const waitingToken = phase.kind === 'waiting' ? phase.session.token : null;
	const waitingSession = phase.kind === 'waiting' ? phase.session : null;
	useEffect(() => {
		if (!waitingToken || !waitingSession) return;
		let stopped = false;
		const poll = setInterval(async () => {
			try {
				const r = await api<{ status: 'pending' | 'done'; result?: CheckResult }>(`/api/check-sessions/${waitingToken}`);
				if (stopped || r.status !== 'done' || !r.result) return;
				stopped = true;
				setPhase({ kind: 'done', result: r.result });
				setExpandedId(r.result.id);
				void qc.invalidateQueries({ queryKey: HISTORY_KEY });
			} catch {
				/* a blip while polling: keep polling */
			}
		}, CHECK_POLL_MS);
		const giveUp = setTimeout(() => {
			stopped = true;
			setPhase({ kind: 'timeout', session: waitingSession });
		}, CHECK_GIVE_UP_MS);
		return () => {
			stopped = true;
			clearInterval(poll);
			clearTimeout(giveUp);
		};
	}, [waitingToken, waitingSession, qc]);

	const reset = () => setPhase({ kind: 'idle' });

	return (
		<div className="space-y-8">
			<PageHeader
				eyebrow={<BackLink to="/">Overview</BackLink>}
				title="Email check"
				description="Send a test email and we audit SPF, DKIM and DMARC for the sending domain, with specific recommendations."
			/>

			<div aria-live="polite">
				{phase.kind === 'idle' || phase.kind === 'creating' ? (
					<Button loading={phase.kind === 'creating'} onClick={() => void start()}>
						Start check
					</Button>
				) : null}

				{phase.kind === 'error' ? <LoadError error={phase.error} onRetry={() => void start()} title="Could not start the check" /> : null}

				{phase.kind === 'waiting' ? <Waiting session={phase.session} onCancel={reset} /> : null}

				{phase.kind === 'timeout' ? (
					<div className="max-w-xl space-y-4">
						<EmptyState
							icon={<MailQuestion />}
							title="No email received yet"
							description={
								<>
									We stopped waiting after {CHECK_GIVE_UP_MS / 60000} minutes. Check that you sent it to <span className="font-mono [overflow-wrap:anywhere]">{phase.session.email}</span>, then keep waiting or start over.
								</>
							}
							action={
								<div className="flex gap-2">
									<Button onClick={() => setPhase({ kind: 'waiting', session: phase.session })}>Retry</Button>
									<Button variant="secondary" onClick={reset}>
										Cancel
									</Button>
								</div>
							}
						/>
					</div>
				) : null}

				{phase.kind === 'done' ? (
					<div className="space-y-4">
						<div className="flex flex-wrap items-start justify-between gap-2">
							<div className="min-w-0">
								<h2 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{phase.result.from_domain}</h2>
								<p className="text-sm text-ink-2">
									sent from {phase.result.from_email} · {formatDateTime(phase.result.created_at)}
								</p>
							</div>
							<OverallBadge status={phase.result.overall_status} />
						</div>
						<ProtocolResults result={phase.result} />
						<Button onClick={reset}>Run another check</Button>
					</div>
				) : null}
			</div>

			<History expandedId={expandedId} setExpandedId={setExpandedId} />
		</div>
	);
}
