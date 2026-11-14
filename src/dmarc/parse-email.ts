// Single entry point for turning raw DMARC report bytes into a typed AggregateReport.
// Chains extractReport() → parseAggregateReportXml(), normalises errors to ParseEmailError.

import { extractReport, ParserError, ReportTooLargeError } from './extract-report';
import { parseAggregateReportXml, type ParseLimits } from './parse-aggregate';
import { AggregateReport, InvalidAggregateReport, ParseStop } from './types';

export type { AggregateReport };

export class ParseEmailError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    /** A reason code (src/hosted/reasons.ts) when the cause is known precisely. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ParseEmailError';
  }
}

/**
 * Parses a DMARC aggregate report from raw attachment bytes.
 *
 * Accepts the output of extractAttachmentBytes() — i.e. Uint8Array that may
 * be a .zip, .gz, raw XML, or base64-encoded version of any of those.
 *
 * @param bytes    Raw bytes from the email attachment.
 * @param offline  Skip IP geolocation lookups (default: false).
 * @param opts     `maxBytes`: refuse reports that decompress to more than this (hosted intake caps at 25 MiB).
 */
export async function parseDmarcEmail(
  bytes: Uint8Array,
  offline = false,
  db?: D1Database,
  opts: { maxBytes?: number } & ParseLimits = {},
): Promise<AggregateReport> {
  let xml: string;

  try {
    xml = extractReport(bytes, opts);
  } catch (err) {
    if (err instanceof ParserError) {
      const code = err instanceof ReportTooLargeError ? 'decompressed_too_large' : /Not a valid zip, gzip, json, or xml/.test(err.message) ? 'wrong_attachment_type' : 'archive_invalid';
      throw new ParseEmailError(`Could not extract XML from attachment: ${err.message}`, err, code);
    }
    throw new ParseEmailError(`Unexpected error extracting attachment`, err);
  }

  // A TLS-RPT report (JSON) sent to the DMARC address: say so, rather than failing as bad XML.
  if (xml.trimStart().startsWith('{')) throw new ParseEmailError('This is a JSON report (TLS-RPT), not a DMARC aggregate report', undefined, 'kind_mismatch_tlsrpt_to_rua');

  try {
    return await parseAggregateReportXml(xml, offline, db, { maxRecords: opts.maxRecords, maxNewIps: opts.maxNewIps, now: opts.now, gate: opts.gate });
  } catch (err) {
    if (err instanceof ParseStop) throw err;
    if (err instanceof InvalidAggregateReport) {
      throw new ParseEmailError(`Invalid DMARC report XML: ${err.message}`, err, (err as { code?: string }).code);
    }
    throw new ParseEmailError(`Unexpected error parsing DMARC XML`, err);
  }
}
