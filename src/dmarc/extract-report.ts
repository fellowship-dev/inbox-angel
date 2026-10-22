import { Gunzip, unzipSync } from 'fflate';

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

export class ReportTooLargeError extends ParserError {}

function tooLarge(max: number): ParserError {
  return new ReportTooLargeError(`Report is larger than ${max} bytes once decompressed`);
}

function gunzip(bytes: Uint8Array, maxBytes?: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const gz = new Gunzip(chunk => {
    total += chunk.length;
    if (maxBytes !== undefined && total > maxBytes) throw tooLarge(maxBytes);
    chunks.push(chunk);
  });
  gz.push(bytes, true);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
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
      const max = opts.maxBytes;
      const files = unzipSync(bytes, max === undefined ? {} : {
        filter: f => {
          if (f.originalSize > max) throw tooLarge(max);
          return true;
        },
      });
      const names = Object.keys(files);
      if (names.length === 0) throw new ParserError('Empty zip archive');
      if (max !== undefined && files[names[0]].length > max) throw tooLarge(max);
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
