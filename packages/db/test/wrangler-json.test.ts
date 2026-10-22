import { describe, expect, it } from 'vitest';
import { parseWranglerJson } from '../src/adopt.js';

describe('parseWranglerJson', () => {
	it('skips config warnings that contain "[WARNING]"', () => {
		const out = ' ⛅️ wrangler\n\n▲ [WARNING] Processing wrangler.jsonc configuration:\n\n    - "unsafe" fields are experimental\n\n[\n  { "results": [{ "x": 1 }], "success": true }\n]\n';
		expect(parseWranglerJson(out)[0].results).toEqual([{ x: 1 }]);
	});

	it('parses plain output', () => {
		expect(parseWranglerJson('[\n  { "results": [] }\n]')[0].results).toEqual([]);
	});

	it('throws a clear error with the head of the output when there is no JSON', () => {
		expect(() => parseWranglerJson('✘ [ERROR] D1 database not found\n')).toThrow(/no JSON result[\s\S]*D1 database not found/);
	});
});
