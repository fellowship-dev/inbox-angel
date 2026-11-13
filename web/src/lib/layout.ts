import { useCallback, useLayoutEffect, useState } from 'react';

/** Observe an element's size; a no-op where ResizeObserver is missing. */
function observe(el: Element, onChange: () => void): () => void {
	if (typeof ResizeObserver === 'undefined') return () => {};
	const ro = new ResizeObserver(onChange);
	ro.observe(el);
	return () => ro.disconnect();
}

/**
 * The rendered width of an element in CSS pixels (0 until measured).
 * Use a callback ref so the measurement follows the element when it mounts or remounts.
 */
export function useElementWidth<T extends Element>(): [(el: T | null) => void, number] {
	const [el, setEl] = useState<T | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!el) return;
		const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
		measure();
		return observe(el, measure);
	}, [el]);
	return [useCallback((node: T | null) => setEl(node), []), width];
}

export interface ScrollEdges {
	/** Content is hidden to the left (the user has scrolled). */
	left: boolean;
	/** Content is hidden to the right. */
	right: boolean;
}

/**
 * Which horizontal edges of a scroll container hide content. Pass a ref to any element inside the
 * scroll container (e.g. the `<table>`); its parent is the container that scrolls.
 */
export function useScrollEdges<T extends HTMLElement>(): [(el: T | null) => void, ScrollEdges] {
	const [el, setEl] = useState<T | null>(null);
	const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
	useLayoutEffect(() => {
		const box = el?.parentElement;
		if (!el || !box) return;
		const measure = () => {
			const left = box.scrollLeft > 1;
			const right = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
			setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
		};
		measure();
		box.addEventListener('scroll', measure, { passive: true });
		const stopBox = observe(box, measure);
		const stopContent = observe(el, measure);
		return () => {
			box.removeEventListener('scroll', measure);
			stopBox();
			stopContent();
		};
	}, [el]);
	return [useCallback((node: T | null) => setEl(node), []), edges];
}
