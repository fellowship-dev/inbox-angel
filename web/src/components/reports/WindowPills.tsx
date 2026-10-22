import { WINDOWS, type WindowDays } from '../../lib/reports';
import { Segmented } from './Segmented';

/** 7 / 30 / 90 day window picker. */
export function WindowPills({ value, onChange }: { value: WindowDays; onChange: (days: WindowDays) => void }) {
	return <Segmented label="Time window" value={value} onChange={onChange} options={WINDOWS.map((d) => ({ value: d, label: `${d}d`, name: `Last ${d} days` }))} />;
}
