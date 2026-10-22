import { Gunzip, Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate';

// Magic bytes — ported from parsedmarc constants
const MAGIC_ZIP  = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
const MAGIC_GZIP = new Uint8Array([0x1f, 0x8b]);
const MAGIC_XML  = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20]); // "<?xml "
const MAGIC_JSON = new Uint8Array([0x7b]);                                 // "{"

export class ParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParserError';
  }
}

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });

/**
 * Extracts XML text from a .zip, .gz, raw XML, or base64-encoded version of any of the above.
 * Ported from parsedmarc extract_report().
 *
 * Accepts:
 *   - Uint8Array / ArrayBuffer — raw bytes
 *   - string — either raw XML/JSON or a base64-encoded archive
 */
export interface ExtractOptions {
  /** Refuse archives that decompress to more than this many bytes (decompression bombs). Default: no limit. */
  maxBytes?: number;
}

export class ReportTooLargeError extends ParserError {
  /** Bytes inflated before the cap stopped us (a bound on the memory a hostile archive could make us use). */
  produced = 0;
}

function tooLarge(max: number, produced: number): ParserError {
  const e = new ReportTooLargeError(`Report is larger than ${max} bytes once decompressed`);
  e.produced = produced;
  return e;
}

/** Compressed bytes fed per step. At worst deflate expands ~1000:1, so a step yields about 1 MB. */
const SLICE = 1024;

/** Feed `bytes` to a streaming inflater in small slices, checking the running output after every one. */
function drain(bytes: Uint8Array, maxBytes: number | undefined, make: (ondata: (chunk: Uint8Array) => void) => { push(c: Uint8Array, final?: boolean): void }): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inflater = make(chunk => {
    total += chunk.length;
    if (maxBytes !== undefined && total > maxBytes) throw tooLarge(maxBytes, total);
    chunks.push(chunk);
  });
  if (maxBytes === undefined) inflater.push(bytes, true);
  else for (let i = 0; i < bytes.length; i += SLICE) inflater.push(bytes.subarray(i, i + SLICE), i + SLICE >= bytes.length);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const gunzip = (bytes: Uint8Array, maxBytes?: number) => drain(bytes, maxBytes, ondata => new Gunzip(ondata));

/** Most entries a hosted-intake zip may hold: a report, plus at most one stray file. */
const MAX_ZIP_ENTRIES = 2;

/** Capped zip: the first .xml/.json entry only, no more than MAX_ZIP_ENTRIES entries, inflated in slices. */
function unzipReport(bytes: Uint8Array, max: number): Uint8Array {
  const entries: { name: string; originalSize: number }[] = [];
  unzipSync(bytes, { filter: f => { entries.push({ name: f.name, originalSize: f.originalSize }); return false; } });
  if (entries.length === 0) throw new ParserError('Empty zip archive');
  if (entries.length > MAX_ZIP_ENTRIES) throw new ParserError(`Zip has ${entries.length} entries; a report has at most ${MAX_ZIP_ENTRIES}`);
  const pick = entries.find(e => /\.(xml|json)$/i.test(e.name));
  if (!pick) throw new ParserError('Zip archive holds no .xml or .json report');
  if (entries.reduce((n, e) => n + e.originalSize, 0) > max) throw tooLarge(max, 0);

  // Only the picked entry is started, so no other entry is ever inflated.
  const parts: Uint8Array[] = [];
  let total = 0;
  let started = false;
  const unzip = new Unzip(file => {
    if (file.name !== pick.name || started) return;
    started = true;
    file.ondata = (err, chunk) => {
      if (err) throw err;
      total += chunk.length;
      if (total > max) throw tooLarge(max, total);
      parts.push(chunk);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  for (let i = 0; i < bytes.length; i += SLICE) unzip.push(bytes.subarray(i, i + SLICE), i + SLICE >= bytes.length);
  if (!started) throw new ParserError('Could not read the report from the zip archive');
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of parts) { out.set(c, at); at += c.length; }
  return out;
}

export function extractReport(content: Uint8Array | ArrayBuffer | string, opts: ExtractOptions = {}): string {
  let bytes: Uint8Array;

  if (typeof content === 'string') {
    // Try base64 decode first; if it fails, treat as plain text
    try {
      const clean = content.replace(/[\r\n]/g, '');
      const binary = atob(clean);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch {
      // Not base64 — return as-is (plain XML/JSON string)
      return content;
    }
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else {
    bytes = content;
  }

  try {
    if (startsWith(bytes, MAGIC_ZIP)) {
      // ZIP: extract first file
      if (opts.maxBytes !== undefined) return decoder.decode(unzipReport(bytes, opts.maxBytes));
      const files = unzipSync(bytes);
      const names = Object.keys(files);
      if (names.length === 0) throw new ParserError('Empty zip archive');
      return decoder.decode(files[names[0]]);
    }

    if (startsWith(bytes, MAGIC_GZIP)) {
      return decoder.decode(gunzip(bytes, opts.maxBytes));
    }

    if (startsWith(bytes, MAGIC_XML) || startsWith(bytes, MAGIC_JSON)) {
      return decoder.decode(bytes);
    }

    throw new ParserError('Not a valid zip, gzip, json, or xml file');
  } catch (e) {
    if (e instanceof ParserError) throw e;
    throw new ParserError(`Invalid archive file: ${e}`);
  }
}
