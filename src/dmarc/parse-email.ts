// Single entry point for turning raw DMARC report bytes into a typed AggregateReport.
// Chains extractReport() → parseAggregateReportXml(), normalises errors to ParseEmailError.

import { extractReport, ParserError } from './extract-report';
import { parseAggregateReportXml, type ParseLimits } from './parse-aggregate';
import { AggregateReport, InvalidAggregateReport } from './types';

export type { AggregateReport };

export class ParseEmailError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
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
      throw new ParseEmailError(`Could not extract XML from attachment: ${err.message}`, err);
    }
    throw new ParseEmailError(`Unexpected error extracting attachment`, err);
  }

  try {
    return await parseAggregateReportXml(xml, offline, db, { maxRecords: opts.maxRecords, maxNewIps: opts.maxNewIps });
  } catch (err) {
    if (err instanceof InvalidAggregateReport) {
      throw new ParseEmailError(`Invalid DMARC report XML: ${err.message}`, err);
    }
    throw new ParseEmailError(`Unexpected error parsing DMARC XML`, err);
  }
}
