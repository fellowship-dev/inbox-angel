#!/usr/bin/env node
/**
 * Rename the product from its old name to Ready Set Mail, deterministically.
 *
 *   node scripts/rename-to-ready-set-mail.mjs [--dry-run] [--paths-out <file>]
 *
 * Run from the repository root on any branch. It rewrites the contents of tracked text files and renames tracked
 * paths (`git mv`), using the ordered MAPPINGS below, then scans again and exits 1 if any form of the old name is left
 * outside the EXCLUSIONS and PROTECTED entries. It is idempotent: a second run changes nothing and exits 0.
 * No dependencies; Node 22+ and git.
 *
 *   --dry-run          report what would change, write nothing
 *   --paths-out <file> write every path the run touched (new paths of renamed files, changed files) one per line,
 *                      so the caller can `git add` exactly those (renames are already staged by `git mv`)
 *
 * After running it, regenerate lockfiles with the package manager (`npm install --package-lock-only`): lockfiles are
 * excluded on purpose because their integrity data must come from npm, not from a text replace.
 *
 * Hostname decisions (every form found in the repository on 2026-11-13, all decided explicitly):
 *   inboxangel.io and every subdomain/address under it (app., www., reports., rua., canary., connect., telemetry.,
 *   h. hosted-records zone, hello@/max@/noreply@/check@/rua@ addresses)  -> same label under readysetmail.com
 *   inboxangel.com and every subdomain/address under it (api., reports.)  -> same label under readysetmail.com
 *   Never readysetmail.io: the .io TLD is rewritten together with the name, in one mapping.
 *   Regex-escaped forms in tests (`inboxangel\.io`) are rewritten to `readysetmail\.com` the same way.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SELF = 'scripts/rename-to-ready-set-mail.mjs';

/** Any form of the old name. Used for the before/after census and the final check. */
const OLD_NAME = /inbox[ _-]?angel/gi;

/**
 * Ordered, most specific first. Each `from` is a RegExp (global); `to` is the replacement string.
 * Later entries never see text an earlier one produced: every replacement is free of the old name.
 */
const ID = '[A-Za-z0-9_$]';
const MAPPINGS = [
	// Hostnames: the name and the TLD change together (never "readysetmail.io").
	{ label: 'inboxangel.io -> readysetmail.com', from: /inboxangel\.io(?![A-Za-z0-9])/g, to: 'readysetmail.com' },
	{ label: 'inboxangel\\.io -> readysetmail\\.com (regex source)', from: /inboxangel\\\.io(?![A-Za-z0-9])/g, to: 'readysetmail\\.com' },
	{ label: 'InboxAngel.io -> ReadySetMail.com', from: /InboxAngel\.io(?![A-Za-z0-9])/g, to: 'ReadySetMail.com' },
	{ label: 'INBOXANGEL.IO -> READYSETMAIL.COM', from: /INBOXANGEL\.IO(?![A-Za-z0-9])/g, to: 'READYSETMAIL.COM' },
	{ label: 'inboxangel.com -> readysetmail.com', from: /inboxangel\.com(?![A-Za-z0-9])/g, to: 'readysetmail.com' },
	{ label: 'inboxangel\\.com -> readysetmail\\.com (regex source)', from: /inboxangel\\\.com(?![A-Za-z0-9])/g, to: 'readysetmail\\.com' },
	// Spaced (prose).
	{ label: 'Inbox Angel -> Ready Set Mail', from: /Inbox Angel/g, to: 'Ready Set Mail' },
	{ label: 'INBOX ANGEL -> READY SET MAIL', from: /INBOX ANGEL/g, to: 'READY SET MAIL' },
	{ label: 'inbox angel -> ready set mail', from: /inbox angel/g, to: 'ready set mail' },
	// Hyphenated (package scope, worker and resource names, HTTP headers, schema ids).
	{ label: 'Inbox-Angel -> Ready-Set-Mail', from: /Inbox-Angel/g, to: 'Ready-Set-Mail' },
	{ label: 'INBOX-ANGEL -> READY-SET-MAIL', from: /INBOX-ANGEL/g, to: 'READY-SET-MAIL' },
	{ label: 'inbox-angel -> ready-set-mail', from: /inbox-angel/g, to: 'ready-set-mail' },
	// Underscored (environment variables, identifiers).
	{ label: 'INBOX_ANGEL -> READY_SET_MAIL', from: /INBOX_ANGEL/g, to: 'READY_SET_MAIL' },
	{ label: 'Inbox_Angel -> Ready_Set_Mail', from: /Inbox_Angel/g, to: 'Ready_Set_Mail' },
	{ label: 'inbox_angel -> ready_set_mail', from: /inbox_angel/g, to: 'ready_set_mail' },
	// CamelCase. Inside a code identifier (an identifier character directly before or after) it stays one word;
	// standing alone it is the brand in prose and becomes the product name "Ready Set Mail".
	// A preceding "\n" / "\t" escape in a string literal is prose, not an identifier.
	{ label: 'InboxAngel (in an identifier) -> ReadySetMail', from: new RegExp(`(?<=(?<!\\\\)${ID})InboxAngel|InboxAngel(?=${ID})`, 'g'), to: 'ReadySetMail' },
	{ label: 'InboxAngel (prose) -> Ready Set Mail', from: /InboxAngel/g, to: 'Ready Set Mail' },
	{ label: 'inboxAngel -> readySetMail', from: /inboxAngel/g, to: 'readySetMail' },
	{ label: 'INBOXANGEL -> READYSETMAIL', from: /INBOXANGEL/g, to: 'READYSETMAIL' },
	{ label: 'Inboxangel -> Readysetmail', from: /Inboxangel/g, to: 'Readysetmail' },
	// Joined lowercase (DNS labels such as _inboxangel, inboxangel-verify=, file names).
	{ label: 'inboxangel -> readysetmail', from: /inboxangel/g, to: 'readysetmail' },
];

/** Paths never touched, with the reason. A path matches when it equals the entry or starts with it (entries ending in "/"). */
const EXCLUSIONS = [
	{ path: '.git/', reason: 'git metadata (also never listed by git ls-files)' },
	{ path: 'node_modules/', reason: 'installed dependencies, not source (untracked)' },
	{ path: 'web/dist/', reason: 'dashboard build output (untracked)' },
	{ path: 'dist/', reason: 'build output (untracked)' },
	{ path: '.wrangler/', reason: 'local Wrangler state (untracked)' },
	{ path: 'tools/audit-fleet/out/', reason: 'audit run output (untracked, third-party domains)' },
	{ path: SELF, reason: 'this script: it must spell the old name to find it' },
	{ path: 'LICENSE', reason: 'licence text: the copyright holder line is legal text, changed only by the owner' },
	{ glob: /(^|\/)package-lock\.json$/, reason: 'npm lockfile: regenerate with `npm install --package-lock-only` instead of text-replacing' },
	{ glob: /(^|\/)(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/, reason: 'other package-manager lockfiles: regenerate with their tool' },
	{ glob: /(^|\/)(THIRD[-_]PARTY|NOTICE|NOTICES)(\.[a-z]+)?$/i, reason: 'third-party notice text' },
	// Skill folders managed by skills-lock.json are added below from the lock file itself (vendored, hash-checked).
];

/**
 * Exact text kept verbatim, with the reason. `file` limits an entry to one path; without it the entry applies
 * everywhere. Lines containing the marker `@legacy-name` are also kept verbatim: hand-written backward-compatibility
 * code that must keep reading an old identifier carries that marker on the same line.
 */
const LINE_MARKER = '@legacy-name';
const PROTECTED = [
	{ file: 'src/connections/crypto.ts', text: "enc.encode('inbox-angel')", reason: 'HKDF salt (a cryptographic domain-separation constant, not a display name) for signed Cloudflare OAuth state; changing it invalidates connection flows in flight across the deploy and gains nothing' },
	{ file: 'src/mail/tokens.ts', text: 'inbox-angel:email-links:v2:', reason: 'HMAC key-derivation label of signed unsubscribe/confirm links already sitting in recipients\' mailboxes; changing it breaks those links' },
	{ text: 'unzip-inboxangel', reason: 'name of the separate repository fellowship-dev/unzip-inboxangel, which was not renamed; provenance notes must stay true' },
	{ file: '.flowchad/config.yml', text: 'inbox-angel-worker.fellowshipdev.workers.dev', reason: 'URL of the live Cloudflare worker inbox-angel-worker; Cloudflare resources are renamed separately' },
	{ file: 'test/e2e/pdf-export.mjs', text: 'inbox-angel-worker.fellowshipdev.workers.dev', reason: 'URL of the live Cloudflare worker inbox-angel-worker; Cloudflare resources are renamed separately' },
	{ text: 'formerly Inbox Angel', reason: 'dated history note that keeps the old name findable' },
];

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|br|wasm|mp4|mov|webm|mp3|wav|sqlite|db)$/i;

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const outIdx = args.indexOf('--paths-out');
const PATHS_OUT = outIdx >= 0 ? args[outIdx + 1] : null;

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function lockedSkillDirs() {
	if (!existsSync('skills-lock.json')) return [];
	try {
		const lock = JSON.parse(readFileSync('skills-lock.json', 'utf8'));
		return Object.entries(lock.skills ?? {}).map(([name, s]) => {
			const dir = s.skillPath ? dirname(s.skillPath) : `.agents/skills/${name}`;
			return { path: `${dir}/`, reason: `vendored skill "${name}" managed by skills-lock.json (hash-checked; update through the skills tool)` };
		});
	} catch {
		return [];
	}
}
const ALL_EXCLUSIONS = [...EXCLUSIONS, ...lockedSkillDirs()].sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));

function exclusionFor(path) {
	for (const e of ALL_EXCLUSIONS) {
		if (e.glob && e.glob.test(path)) return e;
		if (e.path && (path === e.path || (e.path.endsWith('/') && path.startsWith(e.path)) || path === e.path.replace(/\/$/, ''))) return e;
	}
	return null;
}

/** Applies every mapping to `text`, adding to `counts`. Returns the new text. */
function mapText(text, counts) {
	let out = text;
	for (const m of MAPPINGS) {
		out = out.replace(m.from, () => {
			counts[m.label] = (counts[m.label] ?? 0) + 1;
			return m.to;
		});
	}
	return out;
}

/**
 * Splits `text` into segments that may be rewritten and segments kept verbatim (protected literals, marker lines),
 * rewrites the former, and returns the joined result. `kept` collects the protected occurrences found.
 */
function rewrite(path, text, counts, kept) {
	const lines = text.split(/(?<=\n)/); // keep line endings attached
	const protectedHere = PROTECTED.filter(p => !p.file || p.file === path);
	return lines.map(line => {
		if (line.includes(LINE_MARKER)) {
			const n = (line.match(OLD_NAME) ?? []).length;
			if (n) kept.push({ path, what: `line marked ${LINE_MARKER}`, n });
			return line;
		}
		if (!protectedHere.length) return mapText(line, counts);
		// Cut the line at protected literals; rewrite only the gaps.
		let result = '';
		let rest = line;
		for (;;) {
			let best = null;
			for (const p of protectedHere) {
				const i = rest.indexOf(p.text);
				if (i >= 0 && (best === null || i < best.i || (i === best.i && p.text.length > best.p.text.length))) best = { i, p };
			}
			if (!best) { result += mapText(rest, counts); break; }
			result += mapText(rest.slice(0, best.i), counts) + best.p.text;
			kept.push({ path, what: `protected "${best.p.text}"`, n: (best.p.text.match(OLD_NAME) ?? []).length });
			rest = rest.slice(best.i + best.p.text.length);
		}
		return result;
	}).join('');
}

/** Old-name occurrences left in `text` outside protected literals and marker lines. */
function remaining(path, text) {
	const found = [];
	const protectedHere = PROTECTED.filter(p => !p.file || p.file === path);
	text.split('\n').forEach((line, idx) => {
		if (line.includes(LINE_MARKER)) return;
		let scrubbed = line;
		for (const p of protectedHere) scrubbed = scrubbed.split(p.text).join(' '.repeat(p.text.length));
		for (const m of scrubbed.matchAll(OLD_NAME)) found.push({ path, line: idx + 1, form: m[0] });
	});
	return found;
}

const census = (texts) => {
	const forms = {};
	for (const t of texts) for (const m of t.matchAll(OLD_NAME)) forms[m[0]] = (forms[m[0]] ?? 0) + 1;
	return Object.fromEntries(Object.entries(forms).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
};

// ── run ────────────────────────────────────────────────────────────────────────────────────────────────────────────
if (!existsSync('.git') && !existsSync('package.json')) {
	console.error('run from the repository root');
	process.exit(2);
}

// Tracked files with their mode; symlinks (120000) and submodules (160000) are never rewritten.
const entries = git('ls-files', '-s', '-z').split('\0').filter(Boolean).map(l => {
	const [meta, path] = l.split('\t');
	return { mode: meta.split(' ')[0], path };
});
const tracked = [...new Set(entries.map(e => e.path))].sort();
const modeOf = new Map(entries.map(e => [e.path, e.mode]));

const counts = {};
const kept = [];
const changedFiles = [];
const skipped = { excluded: {}, binary: [], symlink: [] };
const beforeTexts = [];
const afterTexts = [];
const afterByPath = new Map(); // tracked path -> resulting text (rewritable files only)

for (const path of tracked) {
	if (!existsSync(path)) continue; // deleted in the working tree
	const ex = exclusionFor(path);
	if (ex) { (skipped.excluded[ex.reason] ??= []).push(path); continue; }
	const mode = modeOf.get(path);
	if (mode === '120000' || mode === '160000' || lstatSync(path).isSymbolicLink()) { skipped.symlink.push(path); continue; }
	if (BINARY_EXT.test(path)) { skipped.binary.push(path); continue; }
	const buf = readFileSync(path);
	if (buf.subarray(0, 8000).includes(0)) { skipped.binary.push(path); continue; }
	const text = buf.toString('utf8');
	beforeTexts.push(text);
	const next = rewrite(path, text, counts, kept);
	afterTexts.push(next);
	afterByPath.set(path, next);
	if (next !== text) {
		changedFiles.push(path);
		if (!DRY) writeFileSync(path, next);
	}
}

// Paths: rename files whose path contains the old name (directories follow their files). Migrations keep their file
// names: wrangler records applied migrations by file name in d1_migrations, so a renamed file would be applied again.
const renames = [];
for (const path of tracked) {
	OLD_NAME.lastIndex = 0;
	if (!OLD_NAME.test(path)) continue;
	if (exclusionFor(path)) continue;
	if (/^migrations\//.test(path)) continue;
	const scratch = {};
	const to = mapText(path, scratch);
	if (to !== path) renames.push({ from: path, to });
}
renames.sort((a, b) => a.from.localeCompare(b.from));
for (const r of renames) {
	if (DRY) continue;
	if (existsSync(r.to)) {
		console.error(`refusing to rename ${r.from}: ${r.to} already exists`);
		process.exit(1);
	}
	mkdirSync(dirname(r.to), { recursive: true });
	git('mv', '--', r.from, r.to);
	// Remove directories the move left empty.
	let dir = dirname(r.from);
	while (dir && dir !== '.' && existsSync(dir) && readdirSync(dir).length === 0) {
		rmdirSync(dir);
		dir = dirname(dir);
	}
}
const renamedTo = new Map(renames.map(r => [r.from, r.to]));

// Final check over the resulting tree: every rewritable file's resulting text, and every resulting path.
const leftovers = [];
for (const path of tracked) {
	if (exclusionFor(path)) continue;
	OLD_NAME.lastIndex = 0;
	const finalPath = renamedTo.get(path) ?? path;
	if (OLD_NAME.test(finalPath) && !/^migrations\//.test(finalPath)) leftovers.push({ path: finalPath, line: 0, form: '(path)' });
}
for (const [path, text] of afterByPath) leftovers.push(...remaining(renamedTo.get(path) ?? path, text));

// ── report ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const touched = [...new Set([...changedFiles.map(p => renamedTo.get(p) ?? p), ...renames.map(r => r.to)])].sort();
if (PATHS_OUT && !DRY) writeFileSync(PATHS_OUT, touched.join('\n') + (touched.length ? '\n' : ''));

const keptSummary = {};
for (const k of kept) {
	const e = (keptSummary[k.what] ??= { n: 0, files: new Set() });
	e.n += k.n;
	e.files.add(k.path);
}

console.log(`rename-to-ready-set-mail${DRY ? ' (dry run)' : ''}`);
console.log(`\nforms of the old name in rewritable files, before: ${JSON.stringify(census(beforeTexts))}`);
console.log(`forms of the old name in rewritable files, after:  ${JSON.stringify(census(afterTexts))} (protected/marked only)`);
console.log(`\nreplacements per mapping:`);
for (const m of MAPPINGS) console.log(`  ${String(counts[m.label] ?? 0).padStart(5)}  ${m.label}`);
console.log(`  ${String(Object.values(counts).reduce((a, b) => a + b, 0)).padStart(5)}  total`);
console.log(`\nfiles changed: ${changedFiles.length}`);
console.log(`files renamed: ${renames.length}`);
for (const r of renames) console.log(`  ${r.from} -> ${r.to}`);
console.log(`\nkept verbatim (protected or ${LINE_MARKER}):`);
for (const [k, e] of Object.entries(keptSummary).sort()) console.log(`  ${String(e.n).padStart(5)}  ${k} in ${e.files.size} file(s): ${[...e.files].sort().slice(0, 3).join(', ')}${e.files.size > 3 ? ', ...' : ''}`);
console.log(`\nexcluded:`);
for (const [reason, paths] of Object.entries(skipped.excluded).sort()) console.log(`  ${paths.length} file(s): ${reason}`);
console.log(`  ${skipped.binary.length} binary file(s); ${skipped.symlink.length} symlink(s): ${skipped.symlink.join(', ') || '-'}`);
if (PATHS_OUT && !DRY) console.log(`\ntouched paths written to ${PATHS_OUT} (${touched.length})`);

if (leftovers.length) {
	console.error(`\nFAIL: ${leftovers.length} occurrence(s) of the old name remain outside the exclusions:`);
	for (const l of leftovers.slice(0, 200)) console.error(`  ${l.path}:${l.line} ${l.form}`);
	process.exit(1);
}
console.log('\nOK: no occurrence of the old name remains outside the exclusions.');
