import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inbox, Settings } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AppShell, Button, CheckResult, CheckResultList, EmptyState, LevelCard, LogoMark, PageHeader, RecordBlock, Skeleton, Stat,
	StatGroup, StatusDot, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, Toaster, dismissToast, toast,
} from "../src";
import { expectNoViolations } from "./a11y";

describe("Toast", () => {
	it("toast() renders title/description with a dismiss button", async () => {
		render(<Toaster />);
		act(() => void toast({ title: "Saved", description: "Sample toast", variant: "success" }));
		expect(await screen.findByText("Saved")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		await waitFor(() => expect(screen.queryByText("Saved")).not.toBeInTheDocument());
	});
	it("dismissToast removes by id", async () => {
		render(<Toaster />);
		let id = 0;
		act(() => void (id = toast({ title: "Gone soon" }).id));
		expect(await screen.findByText("Gone soon")).toBeInTheDocument();
		act(() => dismissToast(id));
		await waitFor(() => expect(screen.queryByText("Gone soon")).not.toBeInTheDocument());
	});
});

describe("Table / EmptyState / Skeleton", () => {
	it("renders headers with scope and rows", () => {
		render(
			<Table label="Domains">
				<TableHeader><TableRow><TableHead>Domain</TableHead></TableRow></TableHeader>
				<TableBody><TableRow><TableCell>example.test</TableCell></TableRow></TableBody>
			</Table>,
		);
		expect(screen.getByRole("columnheader", { name: "Domain" })).toHaveAttribute("scope", "col");
		expect(screen.getByRole("region", { name: "Domains" })).toHaveAttribute("tabindex", "0");
		expect(screen.getByRole("cell", { name: "example.test" })).toBeInTheDocument();
	});
	it("TableEmpty shows an empty state spanning the columns", async () => {
		const { container } = render(
			<Table>
				<TableHeader><TableRow><TableHead>A</TableHead><TableHead>B</TableHead></TableRow></TableHeader>
				<TableBody><TableEmpty colSpan={2} title="No domains yet" description="Add your first domain." action={<Button>Add domain</Button>} /></TableBody>
			</Table>,
		);
		expect(screen.getByText("No domains yet")).toBeInTheDocument();
		expect(container.querySelector("td")).toHaveAttribute("colspan", "2");
		await expectNoViolations(container);
	});
	it("EmptyState has title, description and action", () => {
		render(<EmptyState icon={<Inbox />} title="Nothing here" description="Try later" action={<Button>Do it</Button>} />);
		expect(screen.getByText("Nothing here")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
	});
	it("Skeleton is hidden from assistive tech", () => {
		const { container } = render(<Skeleton data-testid="s" className="h-4 w-20" />);
		expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
	});
});

describe("PageHeader / LogoMark", () => {
	it("renders one h1 with actions", () => {
		render(<PageHeader title="Domain overview" description="d" actions={<Button>Act</Button>} />);
		expect(screen.getByRole("heading", { level: 1, name: "Domain overview" })).toBeInTheDocument();
	});
	it("LogoMark is decorative by default and named when titled", () => {
		const { container, rerender } = render(<LogoMark />);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		rerender(<LogoMark title="Inbox Angel" />);
		expect(screen.getByRole("img", { name: "Inbox Angel" })).toBeInTheDocument();
	});
});

const nav = [{ items: [{ label: "Overview", href: "/", icon: <Inbox />, current: true }, { label: "Settings", href: "/settings", icon: <Settings /> }] }];

describe("AppShell", () => {
	const shell = () => (
		<AppShell brand={<span>Inbox Angel</span>} nav={nav} topbarEnd={<Button size="sm">Account</Button>}>
			<PageHeader title="Hello" />
		</AppShell>
	);
	it("exposes landmarks, current page and a skip link", async () => {
		const { container } = render(shell());
		expect(screen.getAllByRole("navigation", { name: "Main" }).length).toBeGreaterThan(0);
		expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
		expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
		expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
		await expectNoViolations(container);
	});
	it("collapses the sidebar and keeps link names", async () => {
		render(shell());
		const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		await userEvent.click(toggle);
		const expand = screen.getByRole("button", { name: "Expand sidebar" });
		expect(expand).toHaveAttribute("aria-expanded", "false");
		expect(document.querySelector("aside")).toHaveAttribute("data-collapsed", "true");
		expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
	});
	it("opens the mobile drawer and closes it on Escape", async () => {
		render(shell());
		await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
		const dlg = await screen.findByRole("dialog", { name: "Navigation" });
		expect(within(dlg).getByRole("link", { name: "Settings" })).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});
	it("supports a custom link renderer", () => {
		render(<AppShell brand="x" nav={nav} renderLink={(p) => <a data-router {...p} />}>y</AppShell>);
		expect(screen.getAllByRole("link", { name: "Overview" })[0]).toHaveAttribute("data-router");
	});
});

describe("StatusDot / Stat", () => {
	it("StatusDot always has a text label", () => {
		render(<StatusDot status="ok" label="Healthy" />);
		expect(screen.getByText("Healthy")).toBeVisible();
	});
	it("StatusDot hideLabel keeps the label for screen readers only", () => {
		render(<StatusDot status="fail" label="Failing" hideLabel />);
		expect(screen.getByText("Failing")).toHaveClass("sr-only");
	});
	it("each StatusDot status has its own shape, so it works without colour or label", () => {
		const shapes = (["ok", "warn", "fail", "unknown", "info"] as const).map((status) => {
			const { container, unmount } = render(<StatusDot status={status} label={status} hideLabel />);
			const svg = container.querySelector("svg");
			expect(svg).not.toBeNull();
			const html = svg!.innerHTML;
			unmount();
			return html;
		});
		expect(new Set(shapes).size).toBe(5);
	});
	it("Stat shows value, label, sample marker and a delta with direction text", async () => {
		const { container } = render(
			<StatGroup><Stat sample label="Messages" value="1,234" delta={{ value: "+4%", direction: "up", good: true }} deltaLabel="vs. last week" /></StatGroup>,
		);
		expect(screen.getByText("Sample")).toBeInTheDocument();
		expect(screen.getByText("1,234")).toBeInTheDocument();
		expect(screen.getByText(/Up:/)).toHaveClass("sr-only");
		await expectNoViolations(container);
	});
});

describe("RecordBlock", () => {
	const value = "v=DMARC1; p=none; rua=mailto:reports@example.test";
	const setup = () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		// userEvent.setup() installs its own clipboard stub, so override it afterwards.
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		return { writeText, user };
	};
	afterEach(() => vi.useRealTimers());

	it("shows type/name/value in monospace and copies the value", async () => {
		const { writeText, user } = setup();
		const { container } = render(<RecordBlock title="Sample record" record={{ type: "TXT", name: "_dmarc", value }} />);
		expect(screen.getByText("TXT")).toBeInTheDocument();
		expect(screen.getByText("_dmarc")).toHaveClass("font-mono");
		await user.click(screen.getByRole("button", { name: "Copy value" }));
		expect(writeText).toHaveBeenCalledWith(value);
		await act(async () => void (await vi.advanceTimersByTimeAsync(60)));
		expect(screen.getByText("Copied to clipboard")).toHaveAttribute("aria-live", "polite");
		await expectNoViolations(container);
	});
	it("keeps the button name fixed (no double announcement)", async () => {
		const { user } = setup();
		render(<RecordBlock record={{ type: "TXT", name: "_dmarc", value }} />);
		await user.click(screen.getByRole("button", { name: "Copy value" }));
		await act(async () => void (await vi.advanceTimersByTimeAsync(60)));
		expect(screen.getByRole("button", { name: "Copy value" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
	});
	it("announces again on a repeat copy within 2s (live region is cleared first)", async () => {
		const { user } = setup();
		render(<RecordBlock record={{ type: "TXT", name: "_dmarc", value }} />);
		const live = () => screen.getAllByRole("status")[1]!; // [0] is the name field's region
		await user.click(screen.getByRole("button", { name: "Copy value" }));
		await act(async () => void (await vi.advanceTimersByTimeAsync(60)));
		expect(live()).toHaveTextContent("Copied to clipboard");
		await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
		await user.click(screen.getByRole("button", { name: "Copy value" }));
		expect(live()).toBeEmptyDOMElement();
		await act(async () => void (await vi.advanceTimersByTimeAsync(60)));
		expect(live()).toHaveTextContent("Copied to clipboard");
		await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
		expect(live()).toBeEmptyDOMElement();
	});
});

describe("LevelCard", () => {
	it.each([
		[0, "Delivering", 1],
		[1, "Authenticated", 2],
		[2, "Protected", 3],
	] as const)("level %i is %s with %i filled segment(s)", async (level, name, filled) => {
		const { container } = render(
			<LevelCard level={level} domain="example.test" findings={[{ status: "pass", label: "SPF found" }, { status: "missing", label: "No DMARC record" }]} />,
		);
		expect(screen.getByRole("heading", { name: new RegExp(`Level ${level}.*${name}`) })).toBeInTheDocument();
		const bar = screen.getByRole("progressbar", { name: "Protection level" });
		expect(bar).toHaveAttribute("aria-valuenow", String(filled));
		expect(bar).toHaveAttribute("aria-valuetext", `Level ${level} of 2: ${name}`);
		expect(container.querySelectorAll(".bg-brand-ink")).toHaveLength(filled);
		await expectNoViolations(container);
	});
	it("findings carry icon + text status, not colour alone", () => {
		render(<LevelCard level={1} findings={[{ status: "warn", label: "DMARC is p=none" }]} />);
		const item = screen.getByRole("listitem");
		expect(item.querySelector("svg")).not.toBeNull();
		expect(item).toHaveTextContent("Warning: DMARC is p=none");
	});
});

describe("CheckResult", () => {
	it("every status has an icon and a distinct word", async () => {
		const { container } = render(
			<CheckResultList>
				<CheckResult status="pass" title="SPF" />
				<CheckResult status="warn" title="DKIM" />
				<CheckResult status="fail" title="DMARC" />
				<CheckResult status="missing" title="BIMI" />
				<CheckResult status="error" title="MTA-STS" />
			</CheckResultList>,
		);
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(5);
		for (const r of rows) expect(r.querySelector("svg")).not.toBeNull();
		expect(rows[3]).toHaveTextContent("Not found");
		expect(rows[4]).toHaveTextContent("Lookup failed");
		await expectNoViolations(container);
	});
	it("lookup failed is distinct from missing: neutral styling, no 'missing' claim, retry action", async () => {
		const onRetry = vi.fn();
		render(
			<CheckResultList>
				<CheckResult status="missing" title="DMARC" />
				<CheckResult status="error" title="SPF" onRetry={onRetry} />
			</CheckResultList>,
		);
		const [missing, error] = screen.getAllByRole("listitem");
		expect(missing).toHaveClass("bg-danger-subtle");
		expect(error).not.toHaveClass("bg-danger-subtle");
		expect(error).toHaveTextContent(/cannot tell whether the record exists/i);
		expect(error).not.toHaveTextContent("Not found");
		await userEvent.click(within(error!).getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalled();
		expect(within(missing!).queryByRole("button")).toBeNull();
	});
});
