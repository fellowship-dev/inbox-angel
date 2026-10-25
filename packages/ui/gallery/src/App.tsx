import { Button, Toaster } from "@inbox-angel/ui";
import { useEffect, useState } from "react";
import { ComponentsPage } from "./ComponentsPage";
import { DomainOverview } from "./screens/DomainOverview";
import { AuthScreen } from "./screens/AuthScreen";
import { DomainEmpty } from "./screens/DomainEmpty";
import { SetupWizardStep } from "./screens/SetupWizardStep";
import { StatesScreen } from "./screens/StatesScreen";

type View = "components" | "signin" | "setup-owner" | "overview-empty" | "overview" | "wizard" | "loading" | "error";
type Theme = "light" | "dark" | "system";

const views: Array<{ id: View; label: string }> = [
	{ id: "components", label: "Components" },
	{ id: "signin", label: "Sign in" },
	{ id: "setup-owner", label: "Owner setup" },
	{ id: "overview-empty", label: "Empty overview" },
	{ id: "overview", label: "Populated overview" },
	{ id: "wizard", label: "DNS record step" },
	{ id: "loading", label: "Loading" },
	{ id: "error", label: "Retryable error" },
];

const parse = (): { view: View; theme: Theme } => {
	const hash = window.location.hash.replace(/^#\/?/, "");
	const view = (views.find((v) => v.id === hash)?.id ?? "components") as View;
	const t = new URLSearchParams(window.location.search).get("theme");
	return { view, theme: t === "light" || t === "dark" ? t : "system" };
};

export function App() {
	const [state, setState] = useState(parse);
	const { view, theme } = state;

	useEffect(() => {
		const onHash = () => setState((s) => ({ ...s, view: parse().view }));
		window.addEventListener("hashchange", onHash);
		return () => window.removeEventListener("hashchange", onHash);
	}, []);

	useEffect(() => {
		const root = document.documentElement;
		if (theme === "system") root.removeAttribute("data-theme");
		else root.setAttribute("data-theme", theme);
	}, [theme]);

	return (
		<>
			<nav aria-label="Gallery" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface-2 px-4 py-2 text-sm">
				<strong className="text-ink-1">UI gallery</strong>
				<ul className="flex flex-wrap gap-1">
					{views.map((v) => (
						<li key={v.id}>
							<a
								href={`#/${v.id}`}
								aria-current={view === v.id ? "page" : undefined}
								className="rounded-md px-2 py-1 text-ink-2 hover:text-ink-1 aria-[current=page]:bg-brand-subtle aria-[current=page]:text-brand-ink"
							>
								{v.label}
							</a>
						</li>
					))}
				</ul>
				<div role="group" aria-label="Theme" className="ml-auto flex gap-1">
					{(["light", "dark", "system"] as const).map((t) => (
						<Button key={t} size="sm" variant={theme === t ? "primary" : "secondary"} aria-pressed={theme === t} onClick={() => setState((s) => ({ ...s, theme: t }))}>
							{t[0]!.toUpperCase() + t.slice(1)}
						</Button>
					))}
				</div>
			</nav>
			{view === "components" ? <ComponentsPage /> : null}
			{view === "signin" ? <AuthScreen mode="signin" /> : null}
			{view === "setup-owner" ? <AuthScreen mode="setup" /> : null}
			{view === "overview-empty" ? <DomainEmpty /> : null}
			{view === "loading" ? <StatesScreen key="loading" initial="loading" /> : null}
			{view === "error" ? <StatesScreen key="error" initial="error" /> : null}
			{view === "overview" ? <DomainOverview /> : null}
			{view === "wizard" ? <SetupWizardStep /> : null}
			<Toaster />
		</>
	);
}
