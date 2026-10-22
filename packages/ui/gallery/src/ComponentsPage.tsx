import {
	Alert, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, CheckResult, CheckResultList,
	Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, DropdownMenu,
	DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, FieldError,
	FieldHint, IconButton, Input, Textarea, Label, LevelCard, LogoMark, PageHeader, RecordBlock, Select, SelectContent, SelectItem, SelectTrigger,
	SelectValue, Skeleton, Stat, StatGroup, StatusDot, Switch, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader,
	TableRow, Tabs, TabsContent, TabsList, TabsTrigger, toast, Tooltip, TooltipContent,
	TooltipProvider, TooltipTrigger, cn,
} from "@inbox-angel/ui";
import { ChevronDown, Inbox, Plus, Settings, Trash2 } from "lucide-react";
import { useId, type ReactNode } from "react";
import { SAMPLE_DOMAIN, SampleBanner } from "./sample";

/** Renders its children twice: once under data-theme=light, once under data-theme=dark. */
function Both({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className="grid gap-4 lg:grid-cols-2">
			{(["light", "dark"] as const).map((theme) => (
				<div key={theme} data-theme={theme} className="rounded-xl border border-line bg-surface-0 p-5 text-ink-1">
					<p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-2">{theme}</p>
					<div className={cn("space-y-4", className)}>{children}</div>
				</div>
			))}
		</div>
	);
}

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
	return (
		<section aria-labelledby={id} className="space-y-3">
			<div>
				<h2 id={id} className="text-xl font-bold tracking-tight">
					{title}
				</h2>
				{note ? <p className="text-sm text-ink-2">{note}</p> : null}
			</div>
			{children}
		</section>
	);
}

/** Own component so each themed copy gets unique ids. */
function Forms() {
	const p = useId();
	return (
		<>
						<div className="space-y-1.5">
							<Label htmlFor={p + "-domain"}>Domain</Label>
							<Input id={p + "-domain"} placeholder={SAMPLE_DOMAIN} aria-describedby={p + "-domain-hint"} />
							<FieldHint id={p + "-domain-hint"}>The domain you send email from.</FieldHint>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={p + "-bad"}>Report address</Label>
							<Input id={p + "-bad"} defaultValue="not-an-email" aria-invalid="true" aria-describedby={p + "-bad-err"} />
							<FieldError id={p + "-bad-err"}>Enter an address like reports@example.test</FieldError>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={p + "-notes"}>Notes</Label>
							<Textarea id={p + "-notes"} placeholder="Optional" />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={p + "-provider"}>DNS provider</Label>
							<Select defaultValue="cloudflare">
								<SelectTrigger id={p + "-provider"}><SelectValue placeholder="Choose" /></SelectTrigger>
								<SelectContent>
									<SelectItem value="cloudflare">Cloudflare</SelectItem>
									<SelectItem value="route53">Route 53</SelectItem>
									<SelectItem value="other">Other</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex items-center gap-2"><Checkbox id={p + "-cb"} defaultChecked /><Label htmlFor={p + "-cb"}>I added the record</Label></div>
						<div className="flex items-center gap-2"><Checkbox id={p + "-cb2"} checked="indeterminate" /><Label htmlFor={p + "-cb2"}>Some selected</Label></div>
						<div className="flex items-center gap-2"><Switch id={p + "-sw"} defaultChecked /><Label htmlFor={p + "-sw"}>Weekly summary</Label></div>
						<div className="flex items-center gap-2"><Switch id={p + "-sw2"} /><Label htmlFor={p + "-sw2"}>Alerts</Label></div>
		</>
	);
}

const swatches = [
	"surface-0", "surface-1", "surface-2", "surface-3", "ink-1", "ink-2", "ink-3", "brand", "brand-ink", "brand-subtle", "brand-fg",
	"accent", "accent-subtle", "blush", "success", "success-subtle", "warning", "warning-subtle", "danger", "danger-subtle", "line", "line-strong",
] as const;

export function ComponentsPage() {
	return (
		<TooltipProvider>
			<main className="mx-auto max-w-6xl space-y-12 px-4 py-8 sm:px-6">
				<PageHeader
					eyebrow={<span className="flex items-center gap-2"><LogoMark className="h-6 w-auto" /> Inbox Angel design system</span>}
					title="Component gallery"
					description="Every component in light and dark. Sample data throughout."
				/>
				<SampleBanner />

				<Section id="tokens" title="Tokens" note="Surfaces, ink, brand, semantic. Geist Sans / Geist Mono are bundled with the package (no CDN).">
					<Both>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
							{swatches.map((s) => (
								<div key={s} className="flex items-center gap-2 text-xs">
									<span className="size-8 shrink-0 rounded-md border border-line-strong" style={{ background: `var(--${s})` }} />
									<code className="font-mono text-ink-2">{s}</code>
								</div>
							))}
						</div>
						<p className="text-2xl font-bold tracking-tight">Geist Sans: signup emails are bouncing</p>
						<p className="font-mono text-sm">Geist Mono: v=DMARC1; p=none; 550 5.7.26</p>
					</Both>
				</Section>

				<Section id="buttons" title="Button, IconButton">
					<Both>
						<div className="flex flex-wrap gap-2">
							<Button>Primary</Button>
							<Button variant="secondary">Secondary</Button>
							<Button variant="ghost">Ghost</Button>
							<Button variant="danger"><Trash2 aria-hidden />Delete</Button>
							<Button variant="link">Link</Button>
							<Button disabled>Disabled</Button>
							<Button loading>Saving</Button>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm">Small</Button>
							<Button size="md">Medium</Button>
							<Button size="lg">Large</Button>
							<IconButton label="Add domain" variant="secondary"><Plus aria-hidden /></IconButton>
							<IconButton label="Settings"><Settings aria-hidden /></IconButton>
						</div>
					</Both>
				</Section>

				<Section id="forms" title="Input, Textarea, Select, Checkbox, Switch, Label">
					<Both>
						<Forms />
					</Both>
				</Section>

				<Section id="surfaces" title="Card, Badge, Alert">
					<Both>
						<Card>
							<CardHeader><CardTitle>Sending sources</CardTitle><CardDescription>Sample card description.</CardDescription></CardHeader>
							<CardContent>Card body text on surface-1.</CardContent>
							<CardFooter><Button size="sm" variant="secondary">Details</Button></CardFooter>
						</Card>
						<div className="flex flex-wrap gap-2">
							<Badge>Neutral</Badge><Badge variant="brand">Brand</Badge><Badge variant="success">Pass</Badge>
							<Badge variant="warning">Warning</Badge><Badge variant="danger">Fail</Badge><Badge variant="outline">Sample</Badge>
						</div>
						<Alert variant="info" title="Info">Neutral guidance with a <a href="#/components">link</a>.</Alert>
						<Alert variant="success" title="Verified">We found your record.</Alert>
						<Alert variant="warning" title="Heads up">DMARC is monitoring only.</Alert>
						<Alert variant="danger" title="Not found">No SPF record on this domain.</Alert>
					</Both>
				</Section>

				<Section id="overlays" title="Tooltip, Tabs, Dialog, DropdownMenu, Toast">
					<Both>
						<div className="flex flex-wrap items-center gap-2">
							<Tooltip><TooltipTrigger asChild><Button variant="secondary">Hover or focus</Button></TooltipTrigger><TooltipContent>Explains the control</TooltipContent></Tooltip>
							<Dialog>
								<DialogTrigger asChild><Button variant="secondary">Open dialog</Button></DialogTrigger>
								<DialogContent>
									<DialogHeader><DialogTitle>Remove domain?</DialogTitle><DialogDescription>Sample dialog. Nothing is deleted.</DialogDescription></DialogHeader>
									<DialogFooter><DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose><DialogClose asChild><Button variant="danger">Remove</Button></DialogClose></DialogFooter>
								</DialogContent>
							</Dialog>
							<DropdownMenu>
								<DropdownMenuTrigger asChild><Button variant="secondary">Actions <ChevronDown aria-hidden /></Button></DropdownMenuTrigger>
								<DropdownMenuContent>
									<DropdownMenuLabel>{SAMPLE_DOMAIN}</DropdownMenuLabel>
									<DropdownMenuItem>Re-run checks</DropdownMenuItem>
									<DropdownMenuItem>Copy records</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem destructive>Remove</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
							<Button variant="secondary" onClick={() => toast({ title: "Checks re-run", description: "Sample toast, nothing was checked.", variant: "success" })}>Show toast</Button>
						</div>
						<Tabs defaultValue="spf">
							<TabsList aria-label="Records"><TabsTrigger value="spf">SPF</TabsTrigger><TabsTrigger value="dkim">DKIM</TabsTrigger><TabsTrigger value="dmarc">DMARC</TabsTrigger></TabsList>
							<TabsContent value="spf">SPF panel (sample).</TabsContent>
							<TabsContent value="dkim">DKIM panel (sample).</TabsContent>
							<TabsContent value="dmarc">DMARC panel (sample).</TabsContent>
						</Tabs>
					</Both>
				</Section>

				<Section id="data" title="Table, EmptyState, Skeleton">
					<Both>
						<Table label="Sample senders">
							<TableHeader><TableRow><TableHead>Sender</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Messages</TableHead></TableRow></TableHeader>
							<TableBody>
								<TableRow><TableCell className="font-mono">mail.{SAMPLE_DOMAIN}</TableCell><TableCell><StatusDot status="ok" label="Aligned" /></TableCell><TableCell className="text-right tabular-nums">123</TableCell></TableRow>
								<TableRow><TableCell className="font-mono">news.{SAMPLE_DOMAIN}</TableCell><TableCell><StatusDot status="warn" label="Partly aligned" /></TableCell><TableCell className="text-right tabular-nums">45</TableCell></TableRow>
							</TableBody>
						</Table>
						<Table label="Empty sample table">
							<TableHeader><TableRow><TableHead>Sender</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
							<TableBody><TableEmpty colSpan={2} icon={<Inbox />} title="No reports yet" description="Reports arrive within a day of the first email being sent after you publish DMARC." /></TableBody>
						</Table>
						<EmptyState icon={<Inbox />} title="No domains yet" description="Add the domain your signup emails come from." action={<Button><Plus aria-hidden />Add domain</Button>} />
						<div aria-busy="true" className="space-y-2"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /></div>
					</Both>
				</Section>

				<Section id="domain" title="Domain components" note="RecordBlock, LevelCard, CheckResult, StatusDot, Stat. All values are sample data.">
					<Both>
						<RecordBlock title="Sample DMARC record" record={{ type: "TXT", name: "_dmarc", value: `v=DMARC1; p=none; rua=mailto:reports@${SAMPLE_DOMAIN}`, ttl: "Auto" }} />
						<LevelCard level={0} domain={SAMPLE_DOMAIN} findings={[{ status: "pass", label: "MX records found" }, { status: "missing", label: "No SPF record" }]} />
						<LevelCard level={1} domain={SAMPLE_DOMAIN} findings={[{ status: "pass", label: "SPF and DKIM pass" }, { status: "warn", label: "DMARC is p=none", detail: "Monitoring only; spoofed mail is not blocked." }]} />
						<LevelCard level={2} domain={SAMPLE_DOMAIN} findings={[{ status: "pass", label: "DMARC enforced (p=reject)" }, { status: "pass", label: "SPF and DKIM aligned" }]} />
						<CheckResultList>
							<CheckResult status="pass" title="SPF" summary="One record, under the lookup limit." />
							<CheckResult status="warn" title="DKIM" summary="One selector found; 1024-bit key." />
							<CheckResult status="fail" title="DMARC" summary="Policy is invalid." />
							<CheckResult status="missing" title="MTA-STS" summary="No record at _mta-sts." />
							<CheckResult status="error" title="BIMI" onRetry={() => {}} />
						</CheckResultList>
						<div className="flex flex-wrap gap-4">
							<StatusDot status="ok" label="Healthy" /><StatusDot status="warn" label="Needs attention" /><StatusDot status="fail" label="Failing" />
							<StatusDot status="unknown" label="Not checked" /><StatusDot status="info" label="Pending" />
						</div>
						<StatGroup className="sm:grid-cols-3">
							<Stat sample label="Messages" value="1,234" delta={{ value: "+4%", direction: "up", good: true }} deltaLabel="vs. last week" />
							<Stat sample label="Failing" value="12" delta={{ value: "3 more", direction: "up", good: false }} />
							<Stat sample label="Senders" value="7" delta={{ value: "no change", direction: "flat" }} />
						</StatGroup>
					</Both>
				</Section>
			</main>
		</TooltipProvider>
	);
}
