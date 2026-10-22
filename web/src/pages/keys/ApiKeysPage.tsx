import {
	Alert,
	Badge,
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	EmptyState,
	FieldError,
	Input,
	PageHeader,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	toast,
} from '@inbox-angel/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ListSkeleton, LoadError, Section } from '../../components/states';
import { api, ApiError, errorMessage } from '../../lib/api';
import { formatDate, timeAgo } from '../../lib/format';
import { useSession } from '../../lib/session';
import type { ApiKey } from '../../lib/types';
import { Field } from '../auth/AuthLayout';

const keysKey = ['api-keys'] as const;

interface CreatedKey {
	id: string;
	name: string;
	/** The full secret. Lives in this component's state only, never in the query cache. */
	key: string;
	prefix: string;
}

const EXPIRY_OPTIONS = [
	{ value: 'never', label: 'No expiry', days: undefined },
	{ value: '30', label: '30 days', days: 30 },
	{ value: '90', label: '90 days', days: 90 },
	{ value: '365', label: '1 year', days: 365 },
] as const;

export function ApiKeysPage() {
	const { me } = useSession();
	const qc = useQueryClient();
	const keys = useQuery({ queryKey: keysKey, queryFn: () => api<{ keys: ApiKey[] }>('/api/keys').then((r) => r.keys), retry: false });
	const [created, setCreated] = useState<CreatedKey | null>(null);
	const [revoking, setRevoking] = useState<ApiKey | null>(null);
	const [revokingAll, setRevokingAll] = useState(false);

	// Keys belong to people. The deprecated instance key has no user; a key cannot mint more keys.
	const noUser = !me?.user;
	const viaKey = me?.kind === 'api_key';

	const revoke = useMutation({
		mutationFn: (id: string) => api(`/api/keys/${id}`, { method: 'DELETE' }),
		onSuccess: async () => {
			toast({ variant: 'success', title: 'Key revoked', description: 'It stops working immediately.' });
			setRevoking(null);
			await qc.invalidateQueries({ queryKey: keysKey });
		},
	});
	const revokeAll = useMutation({
		mutationFn: () => api<{ revoked: number }>('/api/keys/revoke-all', { method: 'POST', body: {} }),
		onSuccess: async ({ revoked }) => {
			toast({ variant: 'success', title: revoked === 1 ? '1 key revoked' : `${revoked} keys revoked` });
			setRevokingAll(false);
			await qc.invalidateQueries({ queryKey: keysKey });
		},
	});

	const mine = keys.data?.filter((k) => k.user_id === me?.user?.id) ?? [];

	return (
		<div className="space-y-8">
			<PageHeader
				title="API keys"
				description="Use a key to call the Inbox Angel API from scripts and CI. A key acts as you, with your role."
				actions={
					mine.length > 0 ? (
						<Button variant="danger" onClick={() => setRevokingAll(true)}>
							Revoke all my keys
						</Button>
					) : null
				}
			/>

			{noUser ? (
				<Alert variant="info" title="API keys belong to a user">
					You are using the instance API key, which is not tied to a person. Sign in as a user to manage keys.
				</Alert>
			) : (
				<>
					{created ? <SecretOnce created={created} onDone={() => setCreated(null)} /> : null}
					<CreateForm disabledReason={viaKey ? 'Create keys while signed in, not with another key: a key must not outlive its own revocation.' : undefined} onCreated={(c) => { setCreated(c); void qc.invalidateQueries({ queryKey: keysKey }); }} />
				</>
			)}

			<Section title="Your keys" description="We only keep a short prefix of each key, so we cannot show you a key again.">
				{keys.isPending ? (
					<ListSkeleton rows={2} label="Loading API keys" />
				) : keys.isError ? (
					keys.error instanceof ApiError && keys.error.status === 403 ? (
						<EmptyState icon={<KeyRound />} title="No keys for the instance key" description="Sign in as a user to create and manage API keys." />
					) : (
						<LoadError error={keys.error} onRetry={() => keys.refetch()} title="Could not load API keys" />
					)
				) : keys.data.length === 0 ? (
					<EmptyState icon={<KeyRound />} title="No API keys yet" description="Create a key above to call the API from a script." />
				) : (
					<Table label="API keys">
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Key</TableHead>
								<TableHead>Created</TableHead>
								<TableHead>Last used</TableHead>
								<TableHead>Expires</TableHead>
								<TableHead>
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{keys.data.map((k) => (
								<KeyRow key={k.id} k={k} isMine={k.user_id === me?.user?.id} onRevoke={() => setRevoking(k)} />
							))}
						</TableBody>
					</Table>
				)}
			</Section>

			<Dialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Revoke “{revoking?.name}”?</DialogTitle>
						<DialogDescription>Anything using {revoking?.prefix}… stops working immediately. This cannot be undone.</DialogDescription>
					</DialogHeader>
					{revoke.isError ? <FieldError>{errorMessage(revoke.error)}</FieldError> : null}
					<DialogFooter>
						<Button variant="secondary" onClick={() => setRevoking(null)}>
							Cancel
						</Button>
						<Button variant="danger" loading={revoke.isPending} onClick={() => revoking && revoke.mutate(revoking.id)}>
							Revoke key
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={revokingAll} onOpenChange={setRevokingAll}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Revoke all your keys?</DialogTitle>
						<DialogDescription>
							{mine.length === 1 ? 'Your 1 key stops' : `Your ${mine.length} keys stop`} working immediately. Do this if you changed your password or think a key leaked. Other people’s keys are not touched.
						</DialogDescription>
					</DialogHeader>
					{revokeAll.isError ? <FieldError>{errorMessage(revokeAll.error)}</FieldError> : null}
					<DialogFooter>
						<Button variant="secondary" onClick={() => setRevokingAll(false)}>
							Cancel
						</Button>
						<Button variant="danger" loading={revokeAll.isPending} onClick={() => revokeAll.mutate()}>
							Revoke all
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function KeyRow({ k, isMine, onRevoke }: { k: ApiKey; isMine: boolean; onRevoke: () => void }) {
	const expired = k.expires_at !== null && k.expires_at * 1000 <= Date.now();
	return (
		<TableRow>
			<TableCell className="font-medium">
				{k.name}
				{!isMine ? <Badge variant="outline" className="ml-2">teammate</Badge> : null}
			</TableCell>
			<TableCell>
				<code className="font-mono text-sm">{k.prefix}…</code>
			</TableCell>
			<TableCell className="whitespace-nowrap text-ink-2">{formatDate(k.created_at)}</TableCell>
			<TableCell className="whitespace-nowrap text-ink-2">{k.last_used_at ? timeAgo(k.last_used_at) : 'Never used'}</TableCell>
			<TableCell className="whitespace-nowrap text-ink-2">
				{k.expires_at === null ? 'No expiry' : expired ? <Badge variant="danger">Expired {formatDate(k.expires_at)}</Badge> : formatDate(k.expires_at)}
			</TableCell>
			<TableCell className="text-right">
				<Button variant="secondary" size="sm" onClick={onRevoke} aria-label={`Revoke ${k.name}`}>
					Revoke
				</Button>
			</TableCell>
		</TableRow>
	);
}

function CreateForm({ onCreated, disabledReason }: { onCreated: (c: CreatedKey) => void; disabledReason?: string }) {
	const [name, setName] = useState('');
	const [expiry, setExpiry] = useState<string>('never');
	const create = useMutation({
		mutationFn: () => {
			const days = EXPIRY_OPTIONS.find((o) => o.value === expiry)?.days;
			return api<CreatedKey>('/api/keys', { method: 'POST', body: { name: name.trim(), ...(days ? { expires_in_days: days } : {}) } });
		},
		onSuccess: (data) => {
			setName('');
			onCreated(data);
			create.reset(); // drop the secret from the mutation cache as well
		},
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		create.mutate();
	}

	return (
		<Section title="Create a key">
			<form onSubmit={submit} className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
				<Field id="key-name" label="Name" hint={disabledReason ?? 'What it is for, e.g. “CI deploy”.'}>
					<Input id="key-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} disabled={!!disabledReason} aria-describedby="key-name-hint" />
				</Field>
				<Field id="key-expiry" label="Expires">
					<Select value={expiry} onValueChange={setExpiry} disabled={!!disabledReason}>
						<SelectTrigger id="key-expiry" aria-label="Expires">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{EXPIRY_OPTIONS.map((o) => (
								<SelectItem key={o.value} value={o.value}>
									{o.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Button type="submit" loading={create.isPending} disabled={!!disabledReason || !name.trim()}>
					Create key
				</Button>
			</form>
			{create.isError ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
		</Section>
	);
}

/** The one time the secret is on screen. Closing it (or leaving the page) loses it for good. */
function SecretOnce({ created, onDone }: { created: CreatedKey; onDone: () => void }) {
	const [copied, setCopied] = useState(false);
	return (
		<Alert variant="warning" title={`Copy your new key “${created.name}” now`} data-testid="secret-once">
			<div className="space-y-3">
				<p>This is the only time it is shown. If you lose it, revoke it and create another.</p>
				<div className="flex items-center gap-2">
					<code className="min-w-0 flex-1 break-all rounded-md border border-line bg-surface-1 px-3 py-2 font-mono text-sm text-ink-1" data-testid="secret-value">
						{created.key}
					</code>
					<Button
						variant="secondary"
						size="sm"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(created.key);
								setCopied(true);
							} catch {
								toast({ variant: 'warning', title: 'Could not copy', description: 'Select the key and copy it by hand.' });
							}
						}}
					>
						{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
						{copied ? 'Copied' : 'Copy'}
					</Button>
				</div>
				<p className="font-mono text-xs text-ink-2 [overflow-wrap:anywhere]">
					curl -H "X-Api-Key: {created.prefix}…" {window.location.origin}/api/domains
				</p>
				<Button size="sm" onClick={onDone}>
					I have saved it
				</Button>
			</div>
		</Alert>
	);
}
