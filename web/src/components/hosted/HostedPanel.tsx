import { Alert, Button } from '@inbox-angel/ui';
import { RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { hostedError, useHostedConfig, useHostedMutations, useHostedStatus, type HostedAddresses, type HostedStatus } from '../../lib/hosted';
import { ConfirmDialog } from '../domain/ConfirmDialog';
import { ListSkeleton, LoadError, Section, WriteButton } from '../states';
import { AddressesAlert } from './AddressesAlert';
import { EnableDialog } from './EnableDialog';
import { PointerList, lastChecked } from './PointerList';

/** Hosted records for one domain. Renders nothing, and requests nothing, unless hosted mode is on. */
export function HostedPanel({ domainId }: { domainId: number }) {
	const enabled = useHostedConfig();
	if (!enabled) return null;
	return <Panel domainId={domainId} />;
}

function Panel({ domainId }: { domainId: number }) {
	const status = useHostedStatus(domainId);
	// The intake addresses: component state only, never the query cache or storage.
	const [addresses, setAddresses] = useState<HostedAddresses | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [enableOpen, setEnableOpen] = useState(false);
	const [rotateOpen, setRotateOpen] = useState(false);
	const [disableOpen, setDisableOpen] = useState(false);
	const m = useHostedMutations(domainId, setAddresses);
	const panelRef = useRef<HTMLDivElement>(null);

	const dismiss = () => {
		setAddresses(null);
		panelRef.current?.focus();
	};

	let body;
	if (status.isPending) body = <ListSkeleton rows={1} label="Loading hosted records" />;
	else if (status.isError) body = <LoadError error={status.error} onRetry={() => void status.refetch()} title="Could not load hosted records" />;
	else if (!status.data.enabled) {
		body = (
			<div className="space-y-3 rounded-lg border border-line bg-surface-1 p-4">
				<p className="text-sm text-ink-2">
					Let Inbox Angel host your DMARC, SPF and TLS-RPT records. You add a few pointer records to your DNS once, and we keep the records behind them up to date. No more editing
					DNS when something changes.
				</p>
				<WriteButton onClick={() => setEnableOpen(true)}>Enable hosted records</WriteButton>
			</div>
		);
	} else {
		body = (
			<ActiveStatus
				status={status.data}
				verifying={m.verify.isPending}
				verifyError={m.verify.isError ? hostedError(m.verify.error) : null}
				onVerify={() => m.verify.mutate()}
				onRotate={() => setRotateOpen(true)}
				onDisable={() => setDisableOpen(true)}
			/>
		);
	}

	const rotateErr = m.rotate.isError ? hostedError(m.rotate.error) : null;
	const disableErr = m.disable.isError ? hostedError(m.disable.error) : null;

	return (
		<div ref={panelRef} tabIndex={-1} className="outline-none" data-testid="hosted-panel">
			<Section title="Hosted records" description="Inbox Angel publishes and maintains these records for you.">
				{addresses ? <AddressesAlert addresses={addresses} onDismiss={dismiss} /> : null}
				{notice ? (
					<Alert variant="info" title="Already enabled">
						{notice}
					</Alert>
				) : null}
				{body}
			</Section>

			<EnableDialog
				open={enableOpen}
				onOpenChange={(o) => {
					setEnableOpen(o);
					if (!o) m.enable.reset();
				}}
				busy={m.enable.isPending}
				error={m.enable.isError && hostedError(m.enable.error).kind !== 'conflict' ? hostedError(m.enable.error) : null}
				onSubmit={(body) =>
					m.enable.mutate(body, {
						onSuccess: () => {
							setNotice(null);
							setEnableOpen(false);
						},
						onError: (e) => {
							const info = hostedError(e);
							if (info.kind === 'conflict') {
								setNotice(`${info.message} Showing its current status.`);
								setEnableOpen(false);
							}
						},
					})
				}
			/>
			<ConfirmDialog
				open={rotateOpen}
				onOpenChange={(o) => {
					setRotateOpen(o);
					if (!o) m.rotate.reset();
				}}
				title="Rotate the intake token?"
				description="New intake addresses are created and shown once. The previous addresses keep working for 72 hours, so update your DMARC and TLS-RPT senders within that time."
				confirmLabel={rotateErr?.retryable ? 'Retry' : 'Rotate token'}
				busyLabel="Rotating…"
				busy={m.rotate.isPending}
				error={rotateErr ? `${rotateErr.title}. ${rotateErr.message}` : null}
				onConfirm={() => m.rotate.mutate(undefined, { onSuccess: () => setRotateOpen(false) })}
			/>
			<ConfirmDialog
				open={disableOpen}
				onOpenChange={(o) => {
					setDisableOpen(o);
					if (!o) m.disable.reset();
				}}
				title="Disable hosted records?"
				description="Inbox Angel removes the hosted DMARC, SPF, TLS-RPT and MTA-STS records. Remove the pointer records from your DNS too, otherwise they point at nothing and mail authentication will break."
				confirmLabel={disableErr?.retryable ? 'Retry' : 'Disable hosted records'}
				busyLabel="Disabling…"
				variant="danger"
				busy={m.disable.isPending}
				error={disableErr ? `${disableErr.title}. ${disableErr.message}` : null}
				onConfirm={() => m.disable.mutate(undefined, { onSuccess: () => setDisableOpen(false) })}
			/>
		</div>
	);
}

function ActiveStatus({
	status,
	verifying,
	verifyError,
	onVerify,
	onRotate,
	onDisable,
}: {
	status: HostedStatus;
	verifying: boolean;
	verifyError: ReturnType<typeof hostedError> | null;
	onVerify: () => void;
	onRotate: () => void;
	onDisable: () => void;
}) {
	return (
		<div className="space-y-4">
			<p className="text-sm text-ink-2">
				Add these records in your own DNS. They point at the records we host{status.mta_sts ? ', including MTA-STS' : ''}. Each result below comes from looking them up now.
			</p>
			<PointerList status={status} />
			<p className="text-sm text-ink-2">
				A CNAME cannot sit next to other records at the same name. If the name already has a TXT record (for example at <code>_dmarc</code>), remove it before adding the CNAME. For
				SPF, edit your single existing <code>v=spf1</code> record instead of adding a second one.
			</p>
			{verifyError ? (
				<Alert variant="danger" title={verifyError.title}>
					<p>{verifyError.message}</p>
					{verifyError.retryable ? (
						<Button variant="secondary" size="sm" className="mt-3" onClick={onVerify}>
							Retry
						</Button>
					) : null}
				</Alert>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				<WriteButton variant="secondary" size="sm" loading={verifying} onClick={onVerify}>
					<RefreshCw aria-hidden />
					Verify now
				</WriteButton>
				<span className="text-sm text-ink-2">{lastChecked(status.pointer_status.checked_at)}</span>
				<div className="ml-auto flex flex-wrap gap-2">
					<WriteButton variant="secondary" size="sm" onClick={onRotate}>
						Rotate token
					</WriteButton>
					<WriteButton variant="danger" size="sm" onClick={onDisable}>
						Disable hosted records
					</WriteButton>
				</div>
			</div>
		</div>
	);
}
