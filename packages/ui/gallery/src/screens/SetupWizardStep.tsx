import {
	Alert, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, FieldHint, Input, Label, LogoMark,
	RecordBlock, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn,
} from "@inbox-angel/ui";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useId, useState } from "react";
import { SAMPLE_DKIM, SAMPLE_DOMAIN, SAMPLE_EMAIL, SampleBanner } from "../sample";

const steps = ["Domain", "Connect DNS", "Publish records", "Verify"];
const current = 2;

export function SetupWizardStep() {
	const id = useId();
	const [done, setDone] = useState(false);
	return (
		<div className="min-h-screen bg-surface-0 text-ink-1">
			<header className="border-b border-line bg-surface-1">
				<div className="mx-auto flex h-16 max-w-3xl items-center gap-2 px-4 sm:px-6">
					<LogoMark className="size-8 rounded-md" />
					<span className="text-base font-bold tracking-tight">Inbox Angel</span>
					<span className="ml-auto text-sm text-ink-2">Setup</span>
				</div>
			</header>
			<main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
				<SampleBanner>This is a design mock of a setup step. The domain and records are made up.</SampleBanner>

				<nav aria-label="Setup progress">
					<ol className="grid grid-cols-4 gap-2">
						{steps.map((label, i) => {
							const state = i < current ? "done" : i === current ? "current" : "todo";
							return (
								<li key={label} aria-current={state === "current" ? "step" : undefined} className="space-y-1.5">
									<div className={cn("h-1.5 rounded-full", state === "todo" ? "bg-surface-3" : "bg-brand-ink")} />
									<p className={cn("flex items-center gap-1 text-xs sm:text-sm", state === "current" ? "font-semibold text-ink-1" : "text-ink-2")}>
										{state === "done" ? <Check aria-hidden className="size-3.5 text-success" /> : <span className="tabular-nums">{i + 1}.</span>}
										{label}
										{state === "done" ? <span className="sr-only"> (done)</span> : null}
										{state === "current" ? <span className="sr-only"> (current step)</span> : null}
									</p>
								</li>
							);
						})}
					</ol>
				</nav>

				<Card>
					<CardHeader>
						<p className="text-sm text-ink-2">Step 3 of 4</p>
						<CardTitle as="h1" className="text-2xl">Publish your records</CardTitle>
						<CardDescription>
							Add these to the DNS for <span className="font-mono text-ink-1">{SAMPLE_DOMAIN}</span>. Receivers can then check that mail from you is really yours.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-5">
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-provider`}>Where is your DNS hosted?</Label>
							<Select defaultValue="cloudflare">
								<SelectTrigger id={`${id}-provider`}><SelectValue /></SelectTrigger>
								<SelectContent>
									<SelectItem value="cloudflare">Cloudflare</SelectItem>
									<SelectItem value="route53">Amazon Route 53</SelectItem>
									<SelectItem value="other">Somewhere else</SelectItem>
								</SelectContent>
							</Select>
							<FieldHint>We only use this to show the right instructions.</FieldHint>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-rua`}>Where should reports go?</Label>
							<Input id={`${id}-rua`} type="email" defaultValue={SAMPLE_EMAIL} aria-describedby={`${id}-rua-hint`} />
							<FieldHint id={`${id}-rua-hint`}>Aggregate reports from receivers arrive here.</FieldHint>
						</div>
						<RecordBlock title="1. DMARC (TXT record)" record={{ type: "TXT", name: "_dmarc", value: `v=DMARC1; p=none; rua=mailto:${SAMPLE_EMAIL}`, ttl: "Auto" }} />
						<RecordBlock title="2. SPF (TXT record)" record={{ type: "TXT", name: "@", value: "v=spf1 include:_spf.sample-sender.test ~all", ttl: "Auto" }} />
						<RecordBlock title="3. DKIM (TXT record)" record={{ type: "TXT", name: "sample1._domainkey", value: SAMPLE_DKIM, ttl: "Auto" }} />
						<div className="flex items-center gap-2">
							<Checkbox id={`${id}-done`} checked={done} onCheckedChange={(v) => setDone(v === true)} />
							<Label htmlFor={`${id}-done`}>I added all records at my DNS provider</Label>
						</div>
						<Alert variant="info" title="DNS can take a while">
							Changes can take from a few minutes up to a day to be visible. If verification fails right away, wait and try again.
						</Alert>
					</CardContent>
					<CardFooter className="justify-between">
						<Button variant="ghost"><ArrowLeft aria-hidden />Back</Button>
						<Button disabled={!done}>Verify records<ArrowRight aria-hidden /></Button>
					</CardFooter>
				</Card>
			</main>
		</div>
	);
}
