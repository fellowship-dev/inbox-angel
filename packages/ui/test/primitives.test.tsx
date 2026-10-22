import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, Dialog, DialogClose,
	DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DropdownMenu, DropdownMenuContent,
	DropdownMenuItem, DropdownMenuTrigger, FieldError, FieldHint, IconButton, Input, Label, Select, SelectContent, SelectItem,
	SelectTrigger, SelectValue, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, Tooltip, TooltipContent, TooltipProvider,
	TooltipTrigger,
} from "../src";
import { expectNoViolations } from "./a11y";

describe("Button", () => {
	it("renders a type=button with variant classes, className passthrough and forwarded ref", () => {
		const ref = createRef<HTMLButtonElement>();
		render(<Button ref={ref} className="custom" variant="primary">Save</Button>);
		const b = screen.getByRole("button", { name: "Save" });
		expect(b).toHaveAttribute("type", "button");
		expect(b).toHaveClass("bg-brand", "text-brand-fg", "custom");
		expect(ref.current).toBe(b);
	});
	it("primary uses navy text on the brand fill, never white", () => {
		render(<Button>Go</Button>);
		expect(screen.getByRole("button")).not.toHaveClass("text-white");
	});
	it("loading blocks clicks and sets aria-busy", async () => {
		const onClick = vi.fn();
		render(<Button loading onClick={onClick}>Save</Button>);
		const b = screen.getByRole("button", { name: "Save" });
		expect(b).toHaveAttribute("aria-busy", "true");
		await userEvent.click(b);
		expect(onClick).not.toHaveBeenCalled();
	});
	it("asChild styles the child element", () => {
		render(<Button asChild><a href="/x">Link</a></Button>);
		expect(screen.getByRole("link", { name: "Link" })).toHaveClass("bg-brand");
	});
	it("fires onClick and honours disabled", async () => {
		const onClick = vi.fn();
		const { rerender } = render(<Button onClick={onClick}>Go</Button>);
		await userEvent.click(screen.getByRole("button"));
		expect(onClick).toHaveBeenCalledTimes(1);
		rerender(<Button disabled onClick={onClick}>Go</Button>);
		await userEvent.click(screen.getByRole("button"));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
	it("has no axe violations", async () => {
		const { container } = render(<div><Button>A</Button><Button variant="secondary">B</Button><Button variant="danger">C</Button><Button variant="link">D</Button></div>);
		await expectNoViolations(container);
	});
});

describe("IconButton", () => {
	it("is named by its label", () => {
		render(<IconButton label="Open menu"><svg aria-hidden /></IconButton>);
		expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
	});
});

describe("form controls", () => {
	it("Label focuses the associated Input; Input forwards ref and className", async () => {
		const ref = createRef<HTMLInputElement>();
		render(<><Label htmlFor="d">Domain</Label><Input id="d" ref={ref} className="extra" placeholder="example.com" /></>);
		await userEvent.click(screen.getByText("Domain"));
		expect(ref.current).toHaveFocus();
		expect(ref.current).toHaveClass("extra", "border-control");
	});
	it("Input marks invalid via aria-invalid and FieldError is an alert", () => {
		render(<><Input aria-label="Domain" aria-invalid="true" aria-describedby="e" /><FieldError id="e">Enter a valid domain</FieldError><FieldHint>Hint</FieldHint></>);
		expect(screen.getByLabelText("Domain")).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid domain");
	});
	it("Textarea accepts typing", async () => {
		render(<Textarea aria-label="Notes" />);
		await userEvent.type(screen.getByLabelText("Notes"), "hello");
		expect(screen.getByLabelText("Notes")).toHaveValue("hello");
	});
	it("Checkbox toggles with click and Space", async () => {
		const onChange = vi.fn();
		render(<><Checkbox id="c" onCheckedChange={onChange} /><Label htmlFor="c">Agree</Label></>);
		const cb = screen.getByRole("checkbox", { name: "Agree" });
		await userEvent.click(cb);
		expect(cb).toBeChecked();
		cb.focus();
		await userEvent.keyboard(" ");
		expect(cb).not.toBeChecked();
		expect(onChange).toHaveBeenCalledTimes(2);
	});
	it("Switch toggles", async () => {
		render(<><Switch id="s" /><Label htmlFor="s">Alerts</Label></>);
		const sw = screen.getByRole("switch", { name: "Alerts" });
		expect(sw).toHaveAttribute("aria-checked", "false");
		await userEvent.click(sw);
		expect(sw).toHaveAttribute("aria-checked", "true");
	});
	it("Select opens with the keyboard and picks an option", async () => {
		const onValueChange = vi.fn();
		render(
			<Select onValueChange={onValueChange}>
				<SelectTrigger aria-label="Record type"><SelectValue placeholder="Pick" /></SelectTrigger>
				<SelectContent>
					<SelectItem value="txt">TXT</SelectItem>
					<SelectItem value="cname">CNAME</SelectItem>
				</SelectContent>
			</Select>,
		);
		const trigger = screen.getByRole("combobox", { name: "Record type" });
		trigger.focus();
		await userEvent.keyboard("{Enter}");
		expect(await screen.findByRole("option", { name: "CNAME" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("option", { name: "CNAME" }));
		expect(onValueChange).toHaveBeenCalledWith("cname");
	});
	it("has no axe violations", async () => {
		const { container } = render(
			<form>
				<Label htmlFor="a">Name</Label><Input id="a" />
				<Label htmlFor="b">Notes</Label><Textarea id="b" />
				<Checkbox id="c" aria-label="Check" /><Switch aria-label="Switch" />
			</form>,
		);
		await expectNoViolations(container);
	});
});

describe("Card, Badge, Alert", () => {
	it("Card composes and passes className", () => {
		render(<Card className="x" data-testid="card"><CardHeader><CardTitle>T</CardTitle><CardDescription>D</CardDescription></CardHeader><CardContent>C</CardContent><CardFooter>F</CardFooter></Card>);
		expect(screen.getByTestId("card")).toHaveClass("x", "bg-surface-1");
		expect(screen.getByRole("heading", { name: "T" })).toBeInTheDocument();
	});
	it("Badge renders variants", () => {
		render(<Badge variant="success">Pass</Badge>);
		expect(screen.getByText("Pass")).toHaveClass("text-success");
	});
	it("Alert roles: danger/warning announce, info/success are status", () => {
		render(<><Alert variant="danger" title="Bad">x</Alert><Alert variant="info" title="FYI">y</Alert></>);
		expect(screen.getByRole("alert")).toHaveTextContent("Bad");
		expect(screen.getByRole("status")).toHaveTextContent("FYI");
	});
});

describe("Tooltip", () => {
	it("shows on keyboard focus", async () => {
		render(<TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger asChild><button>Hi</button></TooltipTrigger><TooltipContent>Helpful</TooltipContent></Tooltip></TooltipProvider>);
		await userEvent.tab();
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Helpful");
	});
});

describe("Tabs", () => {
	it("switches with arrow keys", async () => {
		render(
			<Tabs defaultValue="a">
				<TabsList aria-label="Sections"><TabsTrigger value="a">One</TabsTrigger><TabsTrigger value="b">Two</TabsTrigger></TabsList>
				<TabsContent value="a">Panel A</TabsContent><TabsContent value="b">Panel B</TabsContent>
			</Tabs>,
		);
		screen.getByRole("tab", { name: "One" }).focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText("Panel B")).toBeVisible();
	});
});

describe("Dialog", () => {
	it("opens, is labelled, and closes with Escape", async () => {
		render(
			<Dialog>
				<DialogTrigger asChild><Button>Open</Button></DialogTrigger>
				<DialogContent>
					<DialogHeader><DialogTitle>Delete domain</DialogTitle><DialogDescription>This cannot be undone.</DialogDescription></DialogHeader>
					<DialogFooter><DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose></DialogFooter>
				</DialogContent>
			</Dialog>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Open" }));
		const dlg = await screen.findByRole("dialog", { name: "Delete domain" });
		expect(dlg).toHaveAccessibleDescription("This cannot be undone.");
		await expectNoViolations(document.body);
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
	});
});

describe("DropdownMenu", () => {
	it("opens from the keyboard and activates an item", async () => {
		const onSelect = vi.fn();
		render(
			<DropdownMenu>
				<DropdownMenuTrigger asChild><Button>Actions</Button></DropdownMenuTrigger>
				<DropdownMenuContent><DropdownMenuItem onSelect={onSelect}>Rename</DropdownMenuItem><DropdownMenuItem destructive>Delete</DropdownMenuItem></DropdownMenuContent>
			</DropdownMenu>,
		);
		screen.getByRole("button", { name: "Actions" }).focus();
		await userEvent.keyboard("{Enter}");
		expect(await screen.findByRole("menu")).toBeInTheDocument();
		await userEvent.keyboard("{Enter}");
		expect(onSelect).toHaveBeenCalled();
	});
});
