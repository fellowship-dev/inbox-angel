import axe from "axe-core";
import { expect } from "vitest";

/** Run axe on a node. jsdom has no layout/paint, so colour-contrast is covered by tokens.test.ts instead. */
export async function expectNoViolations(node: Element | Document = document.body): Promise<void> {
	const results = await axe.run(node as Element, {
		rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
	});
	const msg = results.violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.html).join(" | ")}`).join("\n");
	expect(results.violations, msg).toEqual([]);
}
