// Registrable-domain extraction (Public Suffix List, ICANN section) and seed filtering.

export interface Psl { rules: Set<string>; wildcards: Set<string>; exceptions: Set<string> }

/** Parse publicsuffix.org's public_suffix_list.dat, keeping only the ICANN section. */
export function parsePsl(text: string): Psl {
  const psl: Psl = { rules: new Set(), wildcards: new Set(), exceptions: new Set() };
  let inIcann = true;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.includes('===BEGIN PRIVATE DOMAINS===')) inIcann = false;
    if (line.includes('===BEGIN ICANN DOMAINS===')) inIcann = true;
    if (!inIcann || !line || line.startsWith('//')) continue;
    const rule = line.split(/\s/)[0].toLowerCase();
    if (rule.startsWith('!')) psl.exceptions.add(rule.slice(1));
    else if (rule.startsWith('*.')) psl.wildcards.add(rule.slice(2));
    else psl.rules.add(rule);
  }
  return psl;
}

/** Fallback used when no PSL file is available: common single and multi-label suffixes. */
export const BUILTIN_PSL: Psl = parsePsl(`
com
org
net
io
dev
app
ai
co
me
xyz
sh
so
to
tv
cc
fm
gg
ly
is
it
de
fr
es
nl
se
no
fi
dk
pl
ch
at
be
ie
pt
ru
ua
cz
in
jp
cn
kr
tw
hk
sg
id
vn
th
my
ph
nz
ca
mx
ar
cl
br
za
ng
ke
eu
us
uk
au
co.uk
org.uk
ac.uk
me.uk
com.au
net.au
org.au
co.nz
co.jp
co.in
co.za
co.kr
com.br
com.mx
com.ar
com.tr
com.sg
com.hk
com.tw
com.cn
com.ua
`);

/** Registrable domain (eTLD+1) of a hostname, or null if it is itself a suffix / invalid. */
export function registrableDomain(host: string, psl: Psl = BUILTIN_PSL): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  const labels = h.split('.');
  if (labels.length < 2 || labels.some(l => l === '' || l.length > 63)) return null;
  if (/^\d+(\.\d+){3}$/.test(h)) return null; // IPv4

  // Find the longest matching public suffix length.
  let suffixLen = 1; // implicit "*" rule
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (psl.exceptions.has(candidate)) { suffixLen = labels.length - i - 1; break; }
    const parent = labels.slice(i + 1).join('.');
    if (psl.rules.has(candidate) || (i + 1 < labels.length && psl.wildcards.has(parent))) {
      suffixLen = Math.max(suffixLen, labels.length - i);
      break;
    }
  }
  if (labels.length <= suffixLen) return null;
  return labels.slice(-(suffixLen + 1)).join('.');
}

/** Hosting / site-builder platforms whose subdomains are not custom domains. Matches the host or any subdomain. */
export const PLATFORM_SUFFIXES = [
  'vercel.app', 'now.sh', 'vercel.dev', 'lovable.app', 'lovable.dev', 'lovableproject.com', 'netlify.app', 'netlify.com',
  'pages.dev', 'workers.dev', 'github.io', 'githubusercontent.com', 'gitlab.io', 'herokuapp.com', 'herokussl.com',
  'fly.dev', 'onrender.com', 'railway.app', 'replit.app', 'replit.dev', 'repl.co', 'glitch.me', 'web.app',
  'firebaseapp.com', 'streamlit.app', 'framer.website', 'framer.app', 'framer.ai', 'webflow.io', 'wixsite.com',
  'wix.com', 'squarespace.com', 'carrd.co', 'notion.site', 'notion.so', 'substack.com', 'medium.com', 'bubbleapps.io',
  'bolt.host', 'bolt.new', 'v0.dev', 'v0.app', 'supabase.co', 'supabase.com', 'ngrok.io', 'ngrok.app', 'ngrok-free.app',
  'surge.sh', 'deno.dev', 'deno.net', 'val.run', 'hf.space', 'huggingface.co', 'azurewebsites.net',
  'azurestaticapps.net', 'cloudfront.net', 'amplifyapp.com', 'appspot.com', 'run.app', 'itch.io', 'blogspot.com',
  'wordpress.com', 'tumblr.com', 'hashnode.dev', 'dev.to', 'mmm.page', 'base44.app', 'emergent.sh', 'rork.app',
  'expo.dev', 'expo.app', 'trycloudflare.com', 'ts.net', 'vercel.com', 'netlify.live', 'stackblitz.io',
  'codesandbox.io', 'csb.app', 'gumroad.com', 'beehiiv.com', 'ghost.io', 'bubble.io', 'softr.app', 'glide.page',
  'durable.co', 'godaddysites.com', 'weebly.com', 'jimdosite.com', 'strikingly.com', 'mystrikingly.com',
  'typedream.app', 'super.site', 'readme.io', 'gitbook.io', 'airtable.com', 'typeform.com', 'tilda.ws',
  'myshopify.com', 'shopify.com', 'bigcartel.com', 'carrd.link', 'lovable.so', 'orchids.app', 'same.new', 'same-app.com',
  'appwrite.network', 'convex.site', 'convex.cloud', 'neon.tech', 'planetscale.com', 'koyeb.app', 'zeabur.app',
  'northflank.app', 'up.railway.app', 'vercel.sh', 'workers.cloudflare.com', 'pythonanywhere.com', 'repl.it',
  'adaptable.app', 'cyclic.app', 'dokku.me', 'on.fleek.co', 'ipfs.io', 'ipfs.dweb.link', 'eth.limo', 'js.org',
  'is-a.dev', 'is-cool.dev', 'github.dev', 'gitpod.io', 'codeberg.page', 'sr.ht', 'bitbucket.io',
];

/** Large, non-product sites that show up as submission links (code hosts, social, media, stores, docs). */
export const NON_PRODUCT_DOMAINS = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sourceforge.net', 'youtube.com', 'youtu.be', 'vimeo.com',
  'twitter.com', 'x.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'reddit.com', 'news.ycombinator.com',
  'ycombinator.com', 'producthunt.com', 'indiehackers.com', 'wikipedia.org', 'google.com', 'apple.com',
  'microsoft.com', 'amazon.com', 'npmjs.com', 'pypi.org', 'crates.io', 'rubygems.org', 'pkg.go.dev', 'docker.com',
  'arxiv.org', 'nytimes.com', 'bbc.co.uk', 'theverge.com', 'techcrunch.com', 'wired.com', 'bloomberg.com',
  'twitch.tv', 'discord.com', 'discord.gg', 'telegram.org', 't.me', 'slack.com', 'chromewebstore.google.com',
  'apps.apple.com', 'play.google.com', 'mozilla.org', 'archive.org', 'imgur.com', 'bit.ly', 'tinyurl.com',
  'docs.google.com', 'drive.google.com', 'figma.com', 'dropbox.com', 'cloudflare.com', 'openai.com', 'anthropic.com',
  'stackoverflow.com', 'quora.com', 'mastodon.social', 'bsky.app', 'threads.net', 'tiktok.com', 'patreon.com',
  'buymeacoffee.com', 'ko-fi.com', 'kickstarter.com', 'resend.com', 'react.dev', 'nextjs.org', 'aws.amazon.com',
];

function underAny(host: string, list: string[]): boolean {
  return list.some(s => host === s || host.endsWith('.' + s));
}

export function isPlatformHost(host: string): boolean {
  return underAny(host.toLowerCase(), PLATFORM_SUFFIXES);
}

export type DropReason = 'invalid' | 'platform' | 'non-product';

/**
 * Normalise a URL or hostname to a candidate custom domain.
 * Returns the registrable domain, or a drop reason.
 */
export function candidateDomain(input: string, psl: Psl = BUILTIN_PSL): { domain: string } | { drop: DropReason } {
  let host: string;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { drop: 'invalid' };
  }
  if (isPlatformHost(host)) return { drop: 'platform' };
  const reg = registrableDomain(host, psl);
  if (!reg) return { drop: 'invalid' };
  if (underAny(host, NON_PRODUCT_DOMAINS) || underAny(reg, NON_PRODUCT_DOMAINS)) return { drop: 'non-product' };
  if (isPlatformHost(reg)) return { drop: 'platform' };
  return { domain: reg };
}

export interface SeedRow { domain: string; source: string; ref?: string }

/** Dedupe by registrable domain; keeps first occurrence's source and records all sources joined by "|". */
export function dedupeSeeds(rows: { domain: string; source: string }[]): { domain: string; sources: string[] }[] {
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = map.get(r.domain) ?? new Set<string>();
    s.add(r.source);
    map.set(r.domain, s);
  }
  return [...map].map(([domain, s]) => ({ domain, sources: [...s] }));
}
