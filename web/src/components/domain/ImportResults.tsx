import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@inbox-angel/ui';
import { AlertTriangle, CheckCircle2, Clock, Copy, XCircle } from 'lucide-react';
import { Link } from 'react-router';
import { ClaimCard } from './ClaimCard';
import type { BulkImportItem, BulkImportResponse } from '../../lib/domain-queries';

const STATUS = {
	imported: { label: 'Imported', variant: 'success', Icon: CheckCircle2 },
	duplicate: { label: 'Already added', variant: 'neutral', Icon: Copy },
	invalid: { label: 'Invalid', variant: 'danger', Icon: XCircle },
	error: { label: 'Error', variant: 'danger', Icon: AlertTriangle },
	pending: { label: 'Waiting for verification', variant: 'warning', Icon: Clock },
} as const;

function note(r: BulkImportItem): string {
	const parts: string[] = [];
	if (r.status === 'imported') parts.push(r.manual_dns ? 'DNS provisioning: manual required' : 'DNS provisioned');
	if (r.status === 'pending') parts.push('Add the TXT record below to prove ownership');
	if (r.status === 'duplicate') parts.push('Already registered');
	if (r.error) parts.push(r.error);
	return parts.join('. ');
}

/** Result of POST /api/domains/bulk-import: summary badge, per-domain table, link back to the list. */
export function ImportResults({ result, showNotes = true }: { result: BulkImportResponse; showNotes?: boolean }) {
	return (
		<div className="space-y-4" data-testid="import-results">
			<p>
				<Badge variant={result.imported > 0 ? 'success' : 'neutral'}>
					{result.imported} of {result.total} domain{result.total === 1 ? '' : 's'} imported
				</Badge>
			</p>
			<Table label="Import results">
				<TableHeader>
					<TableRow>
						<TableHead>Domain</TableHead>
						<TableHead>Status</TableHead>
						{showNotes ? <TableHead>Note</TableHead> : null}
					</TableRow>
				</TableHeader>
				<TableBody>
					{result.results.map((r) => {
						const { label, variant, Icon } = STATUS[r.status];
						return (
							<TableRow key={r.domain}>
								<TableCell className="font-mono [overflow-wrap:anywhere]">{r.domain}</TableCell>
								<TableCell>
									<Badge variant={variant}>
										<Icon aria-hidden />
										{label}
									</Badge>
								</TableCell>
								{showNotes ? <TableCell className="text-ink-2">{note(r)}</TableCell> : null}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
			{result.results.some((r) => r.status === 'pending' && r.claim) ? (
				<section aria-labelledby="import-waiting" className="space-y-3">
					<h3 id="import-waiting" className="text-base font-semibold">
						Waiting for verification
					</h3>
					{result.results.flatMap((r) => (r.status === 'pending' && r.claim ? [<ClaimCard key={r.claim.id} claim={r.claim} />] : []))}
				</section>
			) : null}
			{result.imported > 0 ? (
				<Link to="/" className="inline-block text-sm text-brand-ink underline underline-offset-4">
					Back to all domains
				</Link>
			) : null}
		</div>
	);
}
