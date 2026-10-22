import { Button, FieldError, Input, cn } from '@inbox-angel/ui';
import { useId, useState, type KeyboardEvent } from 'react';
import { SPF_PROVIDERS } from '../../../lib/email-service-providers';
import { normalizeCustomInclude } from '../../../lib/spf';

/** Providers matching the query (name or include domain), minus those already selected. */
export function filterProviders(query: string, selected: readonly string[]) {
	const q = query.trim().toLowerCase();
	return SPF_PROVIDERS.filter((p) => !selected.includes(p.include) && (!q || p.name.toLowerCase().includes(q) || p.include.toLowerCase().includes(q)));
}

/**
 * Combobox (ARIA 1.2 list pattern) to add SPF includes: known providers by name or include domain,
 * or any custom domain. Enter picks the highlighted match, Escape closes, arrows move.
 */
export function ProviderPicker({ selected, onAdd, disabled }: { selected: readonly string[]; onAdd: (include: string) => void; disabled?: boolean }) {
	const listId = useId();
	const [query, setQuery] = useState('');
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [error, setError] = useState('');

	const matches = filterProviders(query, selected);
	const custom = normalizeCustomInclude(query);
	const isKnown = SPF_PROVIDERS.some((p) => p.include === query.trim().toLowerCase());
	const canAddCustom = query.trim() !== '' && !isKnown && !selected.includes(custom ?? query.trim().toLowerCase());
	const expanded = open && matches.length > 0;

	function pick(include: string) {
		onAdd(include);
		setQuery('');
		setError('');
		setOpen(false);
		setActive(0);
	}

	function addCustom() {
		if (!custom) {
			setError('Enter a domain name like spf.example.com');
			return;
		}
		pick(custom);
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setOpen(true);
			setActive((a) => Math.min(a + 1, Math.max(matches.length - 1, 0)));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActive((a) => Math.max(a - 1, 0));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const hit = matches[active] ?? matches[0];
			if (open && hit) pick(hit.include);
			else if (canAddCustom) addCustom();
		} else if (e.key === 'Escape') {
			setOpen(false);
		}
	}

	return (
		<div className="space-y-1.5">
			<div className="flex gap-2">
				<div className="relative min-w-0 flex-1">
					<Input
						role="combobox"
						aria-label="Add a sending provider"
						aria-expanded={expanded}
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
						aria-invalid={error ? true : undefined}
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						disabled={disabled}
						placeholder="Search providers or type a custom domain"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setError('');
							setOpen(true);
							setActive(0);
						}}
						onFocus={() => setOpen(true)}
						onBlur={() => setOpen(false)}
						onKeyDown={onKeyDown}
					/>
					<ul
						id={listId}
						role="listbox"
						aria-label="Matching providers"
						hidden={!expanded}
						className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-line-strong bg-surface-1 py-1 shadow-pop"
					>
						{matches.map((p, i) => (
							<li
								key={p.include}
								id={`${listId}-${i}`}
								role="option"
								aria-selected={i === active}
								// mousedown, not click: the input's blur would close the list before a click lands.
								onMouseDown={(e) => {
									e.preventDefault();
									pick(p.include);
								}}
								className={cn('flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm', i === active && 'bg-surface-2')}
							>
								<span className="text-ink-1">{p.name}</span>
								<code className="truncate font-mono text-xs text-ink-2">{p.include}</code>
							</li>
						))}
					</ul>
				</div>
				{canAddCustom ? (
					<Button variant="secondary" disabled={disabled} onClick={addCustom}>
						Add custom
					</Button>
				) : null}
			</div>
			{error ? <FieldError>{error}</FieldError> : null}
		</div>
	);
}
