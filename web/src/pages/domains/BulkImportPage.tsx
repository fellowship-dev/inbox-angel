import { Alert, Button, FieldHint, Label, PageHeader, Textarea } from '@inbox-angel/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ImportResults } from '../../components/domain/ImportResults';
import { ReadOnlyNotice, WriteButton } from '../../components/states';
import { api, errorMessage } from '../../lib/api';
import type { BulkImportResponse } from '../../lib/domain-queries';

export function BulkImportPage() {
	const qc = useQueryClient();
	const [text, setText] = useState('');
	const run = useMutation({
		mutationFn: (domains: string) => api<BulkImportResponse>('/api/domains/bulk-import', { method: 'POST', body: { domains } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['domains'] }),
	});

	function submit(e: FormEvent) {
		e.preventDefault();
		if (text.trim()) run.mutate(text);
	}

	return (
		<div className="max-w-3xl space-y-6">
			<PageHeader
				eyebrow={
					<Link to="/add" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
						<ArrowLeft aria-hidden className="size-4" />
						Add a domain
					</Link>
				}
				title="Import domains"
				description="Paste a list of domains, one per line or separated by commas. Each is added in monitoring mode."
			/>
			<ReadOnlyNotice />
			<form onSubmit={submit} className="space-y-3">
				<Label htmlFor="bulk-domains">Domains</Label>
				<Textarea id="bulk-domains" rows={8} className="font-mono" placeholder={'example.com\nexample.org\nmail.example.net'} value={text} onChange={(e) => setText(e.target.value)} aria-describedby="bulk-hint" />
				<FieldHint id="bulk-hint">Duplicates and invalid names are reported per domain; the rest are still imported.</FieldHint>
				{run.isError ? (
					<Alert variant="danger" title="Import failed">
						{errorMessage(run.error)}
					</Alert>
				) : null}
				<WriteButton type="submit" loading={run.isPending} disabled={!text.trim()}>
					{run.isPending ? 'Importing…' : 'Import domains'}
				</WriteButton>
			</form>
			{run.data ? <ImportResults result={run.data} /> : null}
			<p className="text-sm text-ink-2">
				Looking for subdomains you already have?{' '}
				<Link className="text-brand-ink underline underline-offset-4" to="/ct-discover">
					Find them from certificate logs
				</Link>
				.
			</p>
		</div>
	);
}
