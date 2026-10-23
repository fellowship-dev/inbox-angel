// Apply the saved theme before first paint (no flash). Absent = follow the OS.
// A separate file (not inline) so the CSP can keep script-src 'self' without 'unsafe-inline'.
try {
	var t = localStorage.getItem('ia_theme');
	if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
