// A tokenizer for the Authentication-Results header, RFC 8601 section 2.2 (https://www.rfc-editor.org/rfc/rfc8601#section-2.2):
//
//   authres-header-field = [CFWS] authserv-id [CFWS authres-version] ( no-result / 1*resinfo ) [CFWS]
//   resinfo   = [CFWS] ";" methodspec [CFWS reasonspec] *( CFWS propspec )
//   methodspec = [CFWS] method [CFWS "/" CFWS version] [CFWS] "=" [CFWS] result
//   reasonspec = "reason" [CFWS] "=" [CFWS] value
//   propspec  = ptype [CFWS] "." [CFWS] property [CFWS] "=" pvalue
//   pvalue    = [CFWS] ( value / [[local-part] "@"] domain-name ) [CFWS]
//   value     = token / quoted-string
//
// WHY A TOKENIZER. Everything after the authserv-id of a trusted header is the receiver's words, but many of them are copied from the
// sender: the SMTP mailfrom (quoted local parts may hold spaces and "dkim=pass header.d=google.com"), the HELO name, comments the
// receiver builds from the message, header.i. A method keyword search over the text ("dkim=" anywhere) can be made to see a result the
// receiver never produced. Here a method is only ever read at the START of a resinfo (right after a ";" that is itself outside every
// comment and quoted string), and its properties belong to that method alone.
//
// RULES.
//   - Folded lines are unfolded first (CRLF or LF followed by WSP becomes one space).
//   - Comments nest, with quoted-pairs ("\(" , "\)", "\\"). Quotes are ordinary characters inside a comment. Quoted strings take backslash escapes.
//   - Method, ptype, property and result names are case-insensitive (returned lowercase). Values keep their case.
//   - VERSION. "authserv-id [CFWS] authres-version": only version 1 is defined (RFC 8601 section 2.2). No version means 1. Version "1" is accepted;
//     any other number FAILS CLOSED for the whole header: we cannot know what a later version means, and a receiver that writes one is not
//     the receiver whose semantics we verified. (Method versions, "dkim/1=pass", are accepted when numeric; they do not change the result.)
//   - "none" in place of the results (no-result) yields no methods.
//   - A property that appears twice inside one resinfo fails closed (which one the receiver meant is unknowable).
//   - PROPERTY VALUES are checked (see below): a value a property cannot have drops that whole resinfo, and so does a non-ASCII
//     character in a property value (a Unicode-form IDN): only that result is lost, never the whole header.
//   - TOLERANCE. A bare "word=value" inside a resinfo (a receiver's extension such as "action=none", which RFC 8601 does not define) is
//     not refused: it and the rest of THAT resinfo, up to the next top-level ";" (quotes and comments respected), are skipped, and the
//     method's result and the properties read before it are kept. Skipping can lose a pass (a header.d after the extension is dropped)
//     but can never create one: a method is still only read right after a top-level ";", and what is skipped could equally have been
//     written as a well-formed "ptype.word=value". Anything else unreadable still fails the whole header closed.
//   - What no tokenizer can catch: a receiver that copies a sender-chosen value unquoted, so the sender's ";" starts a resinfo the
//     receiver never wrote. The hosted intake does not believe a carrier whose envelope sender could do that (guardEnvelope,
//     src/dmarc/reporter-auth.ts).
//   - FAILS CLOSED for the whole header, with the reason in `detail`: longer than MAX_HEADER_CHARS; NUL or any other control character
//     (anything below 0x20 except tab, and 0x7F), a stray CR/LF; unbalanced quotes or parentheses; comment nesting over MAX_COMMENT_DEPTH;
//     more than MAX_RESULTS results or MAX_PROPS properties in one; a character outside the grammar (non-ASCII, "\" or ")" outside a quoted
//     string or comment); an empty value; a resinfo that is not method=result. Callers treat a failure as "nothing authenticated".
//   - Linear time, no recursion, no regular expressions over the whole header: no input can make it slow or throw.

/**
 * Longest header value read. Every real receiver's header is under 2 KiB (one resinfo per method, one line each, folded at 78 columns);
 * RFC 5322 suggests lines of at most 998 octets. 8 KiB leaves an order of magnitude of room for long mailfrom/HELO values and comments yet
 * bounds the work and what a sender can stuff into a header the receiver builds from the message.
 */
export const MAX_HEADER_CHARS = 8192;
export const MAX_COMMENT_DEPTH = 32;
export const MAX_RESULTS = 64;
export const MAX_PROPS = 64;
const MAX_COMMENT_CHARS = 512;

export interface AuthResultProp { ptype: string; property: string; value: string }
export interface AuthResultInfo {
  /** Lowercase method: dkim, spf, dmarc, arc, dkim-atps, ... */
  method: string;
  methodVersion: number | null;
  /** Lowercase: pass, fail, ... */
  result: string;
  reason: string | null;
  /** Properties of THIS method only, keyed `ptype.property` lowercase (header.d, smtp.mailfrom). */
  props: Record<string, string>;
  /** Text of the comments inside this resinfo (the receiver's free text: p=reject dis=none), capped. */
  comments: string[];
  /** True when a bare "word=value" extension and the rest of this resinfo were skipped (see TOLERANCE). */
  skipped?: boolean;
}

export type AuthResultsFailure = 'too_long' | 'unsupported_version' | 'malformed';
export type AuthResultsParse =
  | { ok: true; authservId: string; version: 1; results: AuthResultInfo[] }
  | { ok: false; failure: AuthResultsFailure; detail: string };

const fail = (failure: AuthResultsFailure, detail: string): AuthResultsParse => ({ ok: false, failure, detail });

class Stop extends Error {
  constructor(readonly failure: AuthResultsFailure, readonly detail: string) { super(detail); }
}
const stop = (detail: string, failure: AuthResultsFailure = 'malformed'): never => { throw new Stop(failure, detail); };

const isWsp = (c: number) => c === 0x20 || c === 0x09;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
/** Printable ASCII except the specials this grammar reserves: space, "(", ")", '"', ";", "\". Includes "=", "." and "@". */
const isTokenChar = (c: number) => c > 0x20 && c < 0x7f && c !== 0x28 && c !== 0x29 && c !== 0x22 && c !== 0x3b && c !== 0x5c;
const isLdh = (c: number) => isAlpha(c) || isDigit(c) || c === 0x2d;

/** Unfold (CRLF or LF + WSP → one space). A CR or LF that remains is a control character and fails the parse. */
export function unfold(s: string): string {
  return s.replace(/\r?\n(?=[ \t])/g, '');
}

export function tokenizeAuthResults(header: string): AuthResultsParse {
  if (typeof header !== 'string') return fail('malformed', 'not a string');
  if (header.length > MAX_HEADER_CHARS) return fail('too_long', `longer than ${MAX_HEADER_CHARS} characters`);
  const s = unfold(header);
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return fail('malformed', c === 0 ? 'NUL character' : 'control character');
  }
  const n = s.length;
  let i = 0;
  const at = () => (i < n ? s.charCodeAt(i) : -1);

  /** Skips whitespace and nested comments; returns the text of the comments skipped. */
  const cfws = (into?: string[]) => {
    for (;;) {
      const c = at();
      if (isWsp(c)) { i++; continue; }
      if (c !== 0x28) return;
      let depth = 0;
      let text = '';
      for (;;) {
        if (i >= n) stop('unbalanced parenthesis');
        const d = s.charCodeAt(i++);
        if (d === 0x5c) { // quoted-pair
          if (i >= n) stop('unbalanced parenthesis');
          if (depth > 0 && text.length < MAX_COMMENT_CHARS) text += s[i];
          i++;
        } else if (d === 0x28) {
          if (++depth > MAX_COMMENT_DEPTH) stop('comments nested too deeply');
          if (depth > 1 && text.length < MAX_COMMENT_CHARS) text += '(';
        } else if (d === 0x29) {
          if (--depth === 0) break;
          if (text.length < MAX_COMMENT_CHARS) text += ')';
        } else if (depth > 0 && text.length < MAX_COMMENT_CHARS) text += s[i - 1];
      }
      into?.push(text);
    }
  };

  /** A quoted string, unescaped. `i` is at the opening quote. */
  const quoted = (): string => {
    i++;
    let out = '';
    for (;;) {
      if (i >= n) stop('unbalanced quote');
      const c = s.charCodeAt(i++);
      if (c === 0x22) return out;
      if (c === 0x5c) {
        if (i >= n) stop('unbalanced quote');
        out += s[i++];
      } else out += s[i - 1];
    }
  };

  /** value / local@domain: a run of tokens and quoted strings with no CFWS between them ("a b"@example.com is ONE value). */
  const value = (): string => {
    let out = '';
    let any = false;
    for (;;) {
      const c = at();
      if (c === 0x22) { out += quoted(); any = true; continue; }
      if (isTokenChar(c)) { const from = i; while (isTokenChar(at())) i++; out += s.slice(from, i); any = true; continue; }
      break;
    }
    if (!any) stop('a value was expected');
    return out;
  };

  const ldh = (what: string): string => {
    const from = i;
    while (isLdh(at())) i++;
    if (i === from) stop(`${what} expected`);
    return s.slice(from, i).toLowerCase();
  };
  /** Skip to the next top-level ";" (quotes and comments respected), failing closed on a stray ")" or "\\" or an unbalanced construct. */
  const skipRest = (what: string) => {
    for (;;) {
      const c = at();
      if (c === -1 || c === 0x3b) return;
      if (c === 0x22) { quoted(); continue; }
      if (c === 0x28) { cfws(); continue; }
      if (c === 0x29 || c === 0x5c) stop(`stray characters in ${what}`);
      i++;
    }
  };
  /** After a token-like word, the next character must be a delimiter: stops "dkimx=y" style runs from being read as two things. */
  const atBoundary = () => { const c = at(); return c === -1 || isWsp(c) || c === 0x28 || c === 0x3b; };

  try {
    cfws();
    const authservId = value();
    cfws();
    if (isDigit(at())) {
      const from = i;
      while (isDigit(at())) i++;
      const digits = s.slice(from, i);
      if (!atBoundary()) stop('stray characters after the version');
      if (digits !== '1') return fail('unsupported_version', `authres-version ${digits.slice(0, 8)} is not supported (only 1)`);
      cfws();
    } else if (at() !== -1 && at() !== 0x3b) stop('stray characters after the authserv-id');

    const results: AuthResultInfo[] = [];
    let none = false;
    while (i < n) {
      if (at() !== 0x3b) stop('";" expected');
      i++;
      cfws();
      if (i >= n || at() === 0x3b) { if (at() === 0x3b) continue; break; }
      const comments: string[] = [];
      const method = ldh('method');
      cfws(comments);
      let methodVersion: number | null = null;
      if (at() === 0x2f) {
        i++; cfws(comments);
        const from = i;
        while (isDigit(at())) i++;
        if (i === from || i - from > 6) stop('a method version was expected');
        methodVersion = Number(s.slice(from, i));
        cfws(comments);
      }
      if (at() !== 0x3d) {
        // "none" (no-result) is the whole of the results: no method has a result
        if (method === 'none' && methodVersion === null && !results.length && !none) { none = true; if (i < n && at() !== 0x3b) stop('stray characters after none'); continue; }
        stop('"=" expected after the method');
      }
      if (none) stop('results after none');
      i++; cfws(comments);
      const result = ldh('result');
      if (!atBoundary()) stop('stray characters after the result');
      const info: AuthResultInfo = { method, methodVersion, result, reason: null, props: Object.create(null), comments };
      let props = 0;
      let dropped = false;
      for (;;) {
        cfws(comments);
        if (i >= n || at() === 0x3b) break;
        const word = ldh('property type');
        cfws(comments);
        if (word === 'reason' && at() === 0x3d && info.reason === null && props === 0) {
          i++; cfws(comments);
          info.reason = value();
          continue;
        }
        if (at() === 0x3d) {
          // A bare "word=value" extension (see TOLERANCE): skip the rest of this resinfo, failing closed on any structural error.
          skipRest('a skipped extension');
          info.skipped = true;
          break;
        }
        if (at() !== 0x2e) stop('"." expected after the property type');
        i++; cfws(comments);
        const property = ldh('property');
        cfws(comments);
        if (at() !== 0x3d) stop('"=" expected after the property');
        i++; cfws(comments);
        // A non-ASCII character in a property value (a Unicode-form IDN in header.d or smtp.mailfrom, written by a receiver that does not
        // convert it to A-labels) is not a value this grammar has: that whole result is dropped, the rest of the header still counts.
        if (at() > 0x7f) { skipRest('a dropped result'); dropped = true; break; }
        const v = value();
        if (at() > 0x7f) { skipRest('a dropped result'); dropped = true; break; }
        const key = `${word}.${property}`;
        if (key in info.props) stop(`duplicate property ${key.slice(0, 40)}`);
        if (++props > MAX_PROPS) stop('too many properties');
        if (!validPropertyValue(key, v)) {
          // Not a value this property can have (see PROPERTY VALUES): the whole resinfo is dropped, never believed in part.
          skipRest('a dropped result');
          dropped = true;
          break;
        }
        info.props[key] = v;
      }
      if (results.length >= MAX_RESULTS) stop('too many results');
      if (!dropped) results.push(info);
    }
    return { ok: true, authservId, version: 1, results };
  } catch (e) {
    if (e instanceof Stop) return fail(e.failure, e.detail);
    return fail('malformed', 'unreadable'); // never throws
  }
}

// PROPERTY VALUES. A property whose value is not one that property can have (RFC 8601 section 2.7, RFC 5321 for the SMTP ones) means the
// receiver wrote something it should not have, most likely copied from the sender: header.d and smtp.helo a host name (smtp.helo also an
// address literal), header.i "[local]@host", smtp.mailfrom and header.from a host or "local@host" (mailfrom may be empty: the null sender),
// header.s a selector. Such a resinfo is dropped as a whole (it may lose a pass, never create one). Other properties are not checked.
// What this cannot catch: a sender-chosen value that the receiver writes unquoted AND that splits at its ";" into pieces that are each
// valid (a HELO name like "x;dkim=pass(c)header.d=google.com"). Workers do not see the HELO name, so this is decided at go-live by
// inspecting one real routed header (docs/hosted.md, "Going from owner to all").
const HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i;
const isHost = (v: string) => HOST_RE.test(v);
const isAddressLiteral = (v: string) => /^\[(?:IPv6:)?[0-9a-f:.]{2,45}\]$/i.test(v);
const isMailbox = (v: string) => { const at = v.lastIndexOf('@'); return at > 0 && isHost(v.slice(at + 1)); };

export function validPropertyValue(key: string, v: string): boolean {
  switch (key) {
    case 'header.d': return isHost(v);
    case 'smtp.helo': return isHost(v) || isAddressLiteral(v);
    case 'header.i': return v.startsWith('@') ? isHost(v.slice(1)) : isMailbox(v);
    case 'smtp.mailfrom': return v === '' || isHost(v) || isMailbox(v);
    case 'header.from': return isHost(v) || isMailbox(v);
    case 'header.s': return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(v) && v.length <= 253;
    default: return true;
  }
}

/** The domain of a header.d / header.i style value: after the last "@", lowercase, only if it looks like a host name. */
export function domainOfValue(v: string | undefined): string | null {
  if (!v) return null;
  const d = v.slice(v.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
  return d.length <= 253 && d.split('.').every((l) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-')) ? d : null;
}

/**
 * The domain a DKIM result is about: header.d only. header.i is never used: it is optional, the identity may be a subdomain the
 * signer chose, and a tolerant skip can drop header.d while leaving a header.i behind ("dkim=pass header.i=@google.com x-cf=1
 * header.d=attacker.example"). Every real report email in test/fixtures/third-party carries header.d on its DKIM results.
 */
export const dkimDomain = (r: AuthResultInfo): string | null => domainOfValue(r.props['header.d']);
