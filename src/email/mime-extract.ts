// Extracts the DMARC report attachment bytes from a raw MIME email.
// Handles multipart (zip/gz attached) and single-part (base64 or plain XML) bodies.
// Output is a Uint8Array ready to pass into extractReport().

export class MimeExtractError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MimeExtractError';
  }
}

// ── Stream reader ─────────────────────────────────────────────

export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ── MIME header parsing ───────────────────────────────────────

function parseHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  // Unfold headers: CRLF + whitespace continuation → single space
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[key] = value;
  }
  return headers;
}

// ── Body decoding ─────────────────────────────────────────────

function decodeBody(body: string, encoding: string): Uint8Array {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'base64') {
    const clean = body.replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // 7bit / 8bit / quoted-printable — treat as UTF-8 text
  return new TextEncoder().encode(body);
}

// ── Content-Type helpers ──────────────────────────────────────

function isDmarcType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.includes('application/zip') ||
    ct.includes('application/gzip') ||
    ct.includes('application/x-zip') ||
    ct.includes('application/x-gzip') ||
    ct.includes('application/x-zip-compressed') ||
    ct.includes('application/octet-stream') ||
    ct.includes('text/xml') ||
    ct.includes('application/xml')
  );
}

function hasDmarcFilename(s: string): boolean {
  return /\.(xml|gz|zip)(["']|$|;|\s)/i.test(s);
}

function extractBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i);
  return m ? (m[1] ?? m[2]) : null;
}

// ── Multipart splitting ───────────────────────────────────────

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

function splitMultipart(body: string, boundary: string): MimePart[] {
  const delim = `--${boundary}`;
  // Split on boundary lines; ignore epilogue (closing --)
  const sections = body.split(new RegExp(`(?:^|\\r?\\n)${escapeRe(delim)}(?:--)?(?:\\r?\\n|$)`));
  const parts: MimePart[] = [];

  for (const section of sections) {
    if (!section.trim()) continue;
    const blankLine = section.search(/\r?\n\r?\n/);
    if (blankLine < 0) continue;
    const headerText = section.slice(0, blankLine);
    const bodyText = section.slice(blankLine).replace(/^\r?\n/, '');
    parts.push({ headers: parseHeaders(headerText), body: bodyText });
  }
  return parts;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Main export ───────────────────────────────────────────────

/**
 * Reads a raw MIME email stream and returns the DMARC report attachment bytes.
 *
 * Handles:
 *  - multipart/mixed with a zip/gz/xml attachment
 *  - single-part base64-encoded gzip or zip body
 *  - single-part plain UTF-8 XML body
 *
 * Returns a Uint8Array suitable for passing to extractReport().
 */
// Read the full email as a UTF-8 string. Used for TLS-RPT reports (plain JSON body).
export async function extractTextBody(raw: ReadableStream<Uint8Array>): Promise<string> {
  const allBytes = await readStream(raw);
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(allBytes);
}

export async function extractAttachmentBytes(
  raw: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const allBytes = await readStream(raw);
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(allBytes);

  // Split top-level headers from body
  const blankLine = text.search(/\r?\n\r?\n/);
  if (blankLine < 0) throw new MimeExtractError('No MIME headers found');

  const topHeaders = parseHeaders(text.slice(0, blankLine));
  const topBody = text.slice(blankLine).replace(/^\r?\n/, '');
  const contentType = topHeaders['content-type'] ?? '';
  const encoding = topHeaders['content-transfer-encoding'] ?? '7bit';

  // ── Multipart ────────────────────────────────────────────────
  if (contentType.includes('multipart/')) {
    const boundary = extractBoundary(contentType);
    if (!boundary) throw new MimeExtractError('Multipart boundary not found');

    const parts = splitMultipart(topBody, boundary);

    // Pass 1: DMARC-typed Content-Type
    for (const part of parts) {
      const ct = part.headers['content-type'] ?? '';
      if (isDmarcType(ct)) {
        return decodeBody(part.body, part.headers['content-transfer-encoding'] ?? '7bit');
      }
    }

    // Pass 2: filename hint in Content-Disposition or Content-Type
    for (const part of parts) {
      const cd = part.headers['content-disposition'] ?? '';
      const ct = part.headers['content-type'] ?? '';
      if (hasDmarcFilename(cd) || hasDmarcFilename(ct)) {
        return decodeBody(part.body, part.headers['content-transfer-encoding'] ?? '7bit');
      }
    }

    throw new MimeExtractError('No DMARC attachment found in multipart email');
  }

  // ── Single-part ──────────────────────────────────────────────
  return decodeBody(topBody, encoding);
}
