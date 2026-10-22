import { Button, toast } from '@inbox-angel/ui';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** "Copy record" for a value that is not (or not only) shown in a RecordBlock. */
export function CopyButton({ text, label = 'Copy record' }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<Button
			variant="secondary"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
				} catch {
					toast({ variant: 'danger', title: 'Could not copy', description: 'Select the record and copy it by hand.' });
					return;
				}
				setCopied(true);
				toast({ variant: 'success', title: 'Copied to clipboard' });
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
			{copied ? 'Copied' : label}
		</Button>
	);
}
