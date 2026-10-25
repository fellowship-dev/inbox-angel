import * as React from "react";

export interface LogoMarkProps extends React.SVGAttributes<SVGSVGElement> {
	/** Accessible name. Leave undefined when the mark sits next to the product name (decorative). */
	title?: string;
}

/**
 * Inbox Angel mark: gold halo over a gold envelope on a navy square, the same geometry as the website
 * (viewBox 0 0 100 100). The navy square is part of the mark, so it reads in light and dark mode alike.
 * Square: size it with one dimension (`size-8`, `h-7 w-7`); `rounded-md` softens the corners if wanted.
 */
export const LogoMark = React.forwardRef<SVGSVGElement, LogoMarkProps>(({ title, ...props }, ref) => (
	<svg
		ref={ref}
		viewBox="0 0 100 100"
		role={title ? "img" : undefined}
		aria-hidden={title ? undefined : true}
		aria-label={title}
		{...props}
	>
		<rect width="100" height="100" fill="#0b1f3a" />
		<ellipse cx="50" cy="23" rx="19" ry="5.5" fill="none" stroke="#fad172" strokeWidth="4.5" />
		<rect x="20" y="38" width="60" height="40" rx="5" fill="#fad172" />
		<path d="M24 42 50 61 76 42" fill="none" stroke="#0b1f3a" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
));
LogoMark.displayName = "LogoMark";
