import * as React from "react";

export interface LogoMarkProps extends React.SVGAttributes<SVGSVGElement> {
	/** Accessible name. Leave undefined when the mark sits next to the product name (decorative). */
	title?: string;
}

/**
 * Inbox Angel mark (kawaii envelope with halo), after docs/design/brand/inboxangel-kawaii-simple.svg.
 * Outlines use currentColor so they stay visible in dark mode; the face stays dark on the white envelope.
 */
export const LogoMark = React.forwardRef<SVGSVGElement, LogoMarkProps>(({ title, ...props }, ref) => (
	<svg
		ref={ref}
		viewBox="-8 0 296 160"
		role={title ? "img" : undefined}
		aria-hidden={title ? undefined : true}
		aria-label={title}
		fill="none"
		stroke="currentColor"
		strokeLinecap="round"
		strokeLinejoin="round"
		{...props}
	>
		<ellipse cx="140" cy="12" rx="42" ry="10" fill="#fad172" strokeWidth="2" />
		<g strokeWidth="1.8">
			<path d="M 48 58 Q 22 48, 5 30" />
			<path d="M 48 72 Q 18 60, -2 40" />
			<path d="M 48 86 Q 20 76, 5 58" />
			<path d="M 48 100 Q 25 92, 12 78" />
			<path d="M 232 58 Q 258 48, 275 30" />
			<path d="M 232 72 Q 262 60, 282 40" />
			<path d="M 232 86 Q 260 76, 275 58" />
			<path d="M 232 100 Q 255 92, 268 78" />
		</g>
		<rect x="48" y="45" width="184" height="105" rx="6" fill="#fff" strokeWidth="2" />
		<path d="M 48 45 L 140 15 L 232 45 Z" fill="#fad172" strokeWidth="2" />
		<path d="M 52 49 L 140 90 L 228 49" strokeWidth="2" />
		<ellipse cx="78" cy="118" rx="16" ry="7" fill="#fca0a4" stroke="none" opacity="0.7" />
		<ellipse cx="202" cy="118" rx="16" ry="7" fill="#fca0a4" stroke="none" opacity="0.7" />
		<circle cx="100" cy="105" r="7" fill="#333" stroke="none" />
		<circle cx="180" cy="105" r="7" fill="#333" stroke="none" />
		<circle cx="102" cy="103" r="2.5" fill="#fff" stroke="none" />
		<circle cx="182" cy="103" r="2.5" fill="#fff" stroke="none" />
		<path d="M 115 128 Q 140 142, 165 128" stroke="#333" strokeWidth="2" />
	</svg>
));
LogoMark.displayName = "LogoMark";
