import { Alert, Button, Checkbox, EmptyState, FieldHint, Input, Label, PageHeader } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ImportResults } from '../../components/domain/ImportResults';
import { ReadOnlyNotice, WriteButton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import type { BulkImportResponse } from '../../lib/domain-queries';

export function CtDiscoverPage() {
	const qc = useQueryClient();
	const [root, setRoot] = useState('');
	const [found, setFound] = useState<{ domain: string; subdomains: string[] } | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const discover = useMutation({
		mutationFn: (domain: string) => api<{ domain: string; subdomains: string[] }>(`/api/domains/ct-discover?domain=${encodeURIComponent(domain)}`),
		onSuccess: (res) => {
			setFound(res);
			setSelected(new Set(res.subdomains)); // everything starts selected
			importer.reset();
		},
	});
	const importer = useMutation({
		mutationFn: (domains: string[]) => api<BulkImportResponse>('/api/domains/bulk-import', { method: 'POST', body: { domains: domains.join('\n') } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		const d = root.trim().toLowerCase();
		if (d) discover.mutate(d);
	}

	const subs = found?.subdomains ?? [];
	const allSelected = subs.length > 0 && selected.size === subs.length;
	const toggle = (s: string, on: boolean) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (on) next.add(s);
			else next.delete(s);
			return next;
		});

	return (
		<div className="max-w-3xl space-y-6">
			<PageHeader
				eyebrow={
					<Link to="/add" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
						<ArrowLeft aria-hidden className="size-4" />
						Add a domain
					</Link>
				}
				title="Discover subdomains"
				description="Search public Certificate Transparency logs (crt.sh) for subdomains that have had a TLS certificate, then import the ones you want to monitor."
			/>
			<ReadOnlyNotice />
			<form onSubmit={submit} className="space-y-3">
				<Label htmlFor="ct-root">Root domain</Label>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Input id="ct-root" placeholder="yourcompany.com" value={root} onChange={(e) => setRoot(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} />
					<Button type="submit" loading={discover.isPending} disabled={!root.trim()}>
						<Search aria-hidden />
						{discover.isPending ? 'Searching…' : 'Discover'}
					</Button>
				</div>
				<FieldHint>Searching is read-only and public. It can take a few seconds.</FieldHint>
			</form>

			{discover.isError ? (
				<Alert variant="danger" title="Search failed">
					{errorMessage(discover.error)}
					<Button variant="secondary" size="sm" className="mt-3" onClick={() => discover.mutate(root.trim().toLowerCase())}>
						Try again
					</Button>
				</Alert>
			) : null}

			{found && !importer.data ? (
				subs.length === 0 ? (
					<EmptyState title={`No subdomains found for ${found.domain}`} description="Certificate logs list none. Try the apex domain, or add a subdomain by hand." action={<Button asChild variant="secondary"><Link to="/add">Add a domain by hand</Link></Button>} />
				) : (
					<section className="space-y-3" aria-label="Discovered subdomains">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2">
								<Checkbox
									id="ct-all"
									checked={allSelected ? true : selected.size > 0 ? 'indeterminate' : false}
									onCheckedChange={(c) => setSelected(c === true ? new Set(subs) : new Set())}
								/>
								<Label htmlFor="ct-all">
									{subs.length} subdomain{subs.length === 1 ? '' : 's'} found
								</Label>
							</div>
							<p className="text-sm text-ink-2" aria-live="polite">
								{selected.size} selected
							</p>
						</div>
						<ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface-1" tabIndex={0} aria-label="Subdomains">
							{subs.map((s, i) => (
								<li key={s} className="flex items-center gap-3 px-4 py-2.5">
									<Checkbox id={`ct-${i}`} checked={selected.has(s)} onCheckedChange={(c) => toggle(s, c === true)} />
									<Label htmlFor={`ct-${i}`} className="min-w-0 font-mono font-normal [overflow-wrap:anywhere]">
										{s}
									</Label>
								</li>
							))}
						</ul>
						{importer.isError ? (
							<Alert variant="danger" title="Import failed">
								{errorMessage(importer.error)}
							</Alert>
						) : null}
						<WriteButton loading={importer.isPending} disabled={selected.size === 0} onClick={() => importer.mutate(subs.filter((s) => selected.has(s)))}>
							{importer.isPending ? 'Importing…' : `Import ${selected.size} selected`}
						</WriteButton>
					</section>
				)
			) : null}

			{importer.data ? <ImportResults result={importer.data} showNotes={false} /> : null}
		</div>
	);
}
