import { Badge, Button, Card, CardContent, FieldError, Input, PageHeader, Skeleton, toast } from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, Sun } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ReadOnlyNotice, Section, WriteButton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import { useSession } from '../../lib/session';
import { setTheme, useTheme } from '../../lib/theme';
import { Field } from '../auth/AuthLayout';

interface VersionInfo {
	current: string;
	latest: string | null;
	update_available: boolean;
	release_url: string;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-4">
			<dt className="text-sm text-ink-2">{label}</dt>
			<dd className="min-w-0 break-words text-sm text-ink-1">{children}</dd>
		</div>
	);
}

export function SettingsPage() {
	const { me, role, status, signOut } = useSession();
	const { theme } = useTheme();
	const qc = useQueryClient();
	const version = useQuery({ queryKey: ['version'], queryFn: () => api<VersionInfo>('/api/version'), staleTime: 3_600_000, retry: false });

	const customDomain = useMutation({
		mutationFn: () => api<{ hostname: string }>('/api/setup/custom-domain', { method: 'POST' }),
		onSuccess: async ({ hostname }) => {
			toast({ variant: 'success', title: 'Custom domain registered', description: hostname });
			await qc.invalidateQueries({ queryKey: ['auth-status'] });
		},
	});

	return (
		<div className="space-y-10">
			<PageHeader title="Settings" description="Your account and this Inbox Angel instance." />
			<ReadOnlyNotice />

			<Section title="Account">
				<Card>
					<CardContent className="py-2">
						<dl className="divide-y divide-line">
							<Row label="Name">{me?.user?.name ?? 'Instance API key'}</Row>
							<Row label="Email">{me?.user?.email ?? 'Not tied to a user'}</Row>
							<Row label="Role">{role ? <Badge variant="brand">{role}</Badge> : null}</Row>
						</dl>
					</CardContent>
				</Card>
				{me?.user ? <ChangePassword /> : null}
				<div>
					<Button variant="secondary" onClick={() => void signOut()}>
						Sign out
					</Button>
				</div>
			</Section>

			<Section title="Appearance" description="Follows your system until you choose.">
				<div className="flex flex-wrap gap-2" role="group" aria-label="Theme">
					<Button variant={theme === 'light' ? 'primary' : 'secondary'} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>
						<Sun aria-hidden />
						Light
					</Button>
					<Button variant={theme === 'dark' ? 'primary' : 'secondary'} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>
						<Moon aria-hidden />
						Dark
					</Button>
				</div>
			</Section>

			<Section title="Instance">
				<Card>
					<CardContent className="py-2">
						<dl className="divide-y divide-line">
							<Row label="Version">
								{version.isPending ? (
									<Skeleton className="h-4 w-24" />
								) : version.isError ? (
									<span className="text-ink-2">Could not check for updates</span>
								) : (
									<>
										v{version.data.current}{' '}
										{version.data.update_available ? (
											<a className="text-brand-ink underline underline-offset-4" href={version.data.release_url} target="_blank" rel="noreferrer">
												v{version.data.latest} available
											</a>
										) : (
											<span className="text-ink-2">(up to date)</span>
										)}
									</>
								)}
							</Row>
							<Row label="Mode">{status?.mode === 'saas' ? 'Hosted' : 'Self-hosted'}</Row>
							<Row label="Base domain">{status?.base_domain ?? <span className="text-ink-2">Not set: the setup wizard sets it.</span>}</Row>
							<Row label="Dashboard address">
								{status?.custom_domain ? (
									<a className="text-brand-ink underline underline-offset-4" href={`https://${status.custom_domain}`}>
										{status.custom_domain}
									</a>
								) : (
									<span className="flex flex-wrap items-center gap-3">
										<span className="text-ink-2">Using the default workers.dev address.</span>
										{status?.base_domain ? (
											<WriteButton size="sm" variant="secondary" loading={customDomain.isPending} onClick={() => customDomain.mutate()}>
												Use inbox-angel.{status.base_domain}
											</WriteButton>
										) : null}
									</span>
								)}
							</Row>
							<Row label="Anonymous usage stats">{status?.telemetry_default ? 'Shared' : 'Not shared'}</Row>
						</dl>
					</CardContent>
				</Card>
				{customDomain.isError ? <FieldError>{errorMessage(customDomain.error)}</FieldError> : null}
				<p className="text-sm text-ink-2">
					Need to script something? <Link to="/keys" className="text-brand-ink underline underline-offset-4">Create an API key</Link>.
				</p>
			</Section>
		</div>
	);
}

function ChangePassword() {
	const [current, setCurrent] = useState('');
	const [next, setNext] = useState('');
	const [confirm, setConfirm] = useState('');
	const [error, setError] = useState('');
	const change = useMutation({
		mutationFn: () => api('/api/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } }),
		onSuccess: () => {
			setCurrent('');
			setNext('');
			setConfirm('');
			toast({ variant: 'success', title: 'Password changed', description: 'Other devices were signed out. Your API keys still work: revoke them if you are worried about one.' });
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		setError('');
		if (next.length < 8) return setError('New password must be at least 8 characters.');
		if (next !== confirm) return setError('Passwords do not match.');
		change.mutate();
	}

	return (
		<Card>
			<CardContent className="space-y-4 p-5">
				<h3 className="font-semibold">Change password</h3>
				<form onSubmit={submit} className="grid max-w-md gap-4">
					<Field id="current-password" label="Current password">
						<Input id="current-password" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
					</Field>
					<Field id="new-password" label="New password" hint="At least 8 characters. Other devices are signed out.">
						<Input id="new-password" type="password" required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="new-password-hint" />
					</Field>
					<Field id="confirm-password" label="Confirm new password">
						<Input id="confirm-password" type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
					</Field>
					{error || change.isError ? <FieldError>{error || errorMessage(change.error)}</FieldError> : null}
					<div>
						<Button type="submit" loading={change.isPending}>
							Change password
						</Button>
					</div>
				</form>
			</CardContent>
		</Card>
	);
}

