import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LevelLadder, STATUS, STATUS_FROM_CHECK, STATUS_FROM_FINDING, STATUS_RANK, StatusLabel, worstStatus, type StatusKind } from "../src";
import { expectNoViolations } from "./a11y";

const KINDS = Object.keys(STATUS) as StatusKind[];

describe("shared status vocabulary", () => {
	it("uses the website's eight words, most urgent first", () => {
		expect(STATUS_RANK.map((k) => STATUS[k].label)).toEqual([
			"Needs attention",
			"Awaiting your approval",
			"Worth fixing",
			"Unknown",
			"Still gathering evidence",
			"Change prepared",
			"Verified",
			"Note",
		]);
		expect(new Set(KINDS.map((k) => STATUS[k].Icon)).size).toBe(KINDS.length); // a distinct shape each, so colour is never the only cue
	});

	it("a whole result takes its most urgent state; notes alone read as verified", () => {
		expect(worstStatus(["verified", "improve", "unknown"])).toBe("improve");
		expect(worstStatus(["note"])).toBe("verified");
		expect(worstStatus([])).toBe("verified");
	});

	it("maps the existing per-check states without folding unknown into missing", () => {
		expect(STATUS_FROM_CHECK.error).toBe("unknown");
		expect(STATUS_FROM_CHECK.missing).toBe("attention");
		expect(STATUS_FROM_FINDING.unknown).toBe("unknown");
	});

	it("StatusLabel shows an icon and the word", async () => {
		const { container } = render(
			<p>
				{KINDS.map((k) => (
					<StatusLabel key={k} kind={k} />
				))}
			</p>,
		);
		for (const k of KINDS) {
			const el = screen.getByText(STATUS[k].label);
			expect(el.closest("[data-status]")).toHaveAttribute("data-status", k);
			expect(el.closest("[data-status]")?.querySelector("svg")).not.toBeNull();
		}
		await expectNoViolations(container);
	});
});

describe("LevelLadder", () => {
	it.each([
		[0, "Delivering", 1],
		[1, "Authenticated", 2],
		[2, "Protected", 3],
	] as const)("level %i: %s is the current rung, on the gold accent", async (level, name, filled) => {
		const { container } = render(<LevelLadder level={level} />);
		const bar = screen.getByRole("progressbar", { name: "Protection level" });
		expect(bar).toHaveAttribute("aria-valuenow", String(filled));
		expect(bar).toHaveAttribute("aria-valuetext", `Level ${level} of 2: ${name}`);
		expect(container.querySelectorAll(".bg-brand-ink")).toHaveLength(filled);
		expect(screen.getByText(name).closest("p")).toHaveClass("bg-accent", "text-accent-fg");
		await expectNoViolations(container);
	});

	it("an unknown level fills nothing and says so in words", async () => {
		const { container } = render(<LevelLadder level={null} />);
		const bar = screen.getByRole("progressbar");
		expect(bar).not.toHaveAttribute("aria-valuenow");
		expect(bar).toHaveAttribute("aria-valuetext", "Level not known yet");
		expect(container.querySelectorAll(".bg-brand-ink, .bg-accent")).toHaveLength(0);
		expect(screen.getByText("Level not known yet")).toBeInTheDocument();
		await expectNoViolations(container);
	});
});
