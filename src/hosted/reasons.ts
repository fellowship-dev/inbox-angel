// Why an inbound message was refused, deferred or accepted: one code per cause. The code goes in the structured log line
// (src/hosted/intake-log.ts) and in `intake_failures`; the SMTP text is what the sending server is told (it never repeats
// anything the sender wrote, and never names a token or an address).

export type Outcome = 'accepted' | 'duplicate' | 'refused' | 'deferred';

export const REASONS = {
  ok: 'Accepted',
  duplicate: 'This report was already received',
  bad_recipient: 'Unknown recipient',
  wrong_host: 'Unknown recipient',
  unknown_token: 'Unknown intake token',
  raw_too_large: 'Report is larger than the allowed size',
  cap_address_day: 'Daily intake limit for this address reached; try again tomorrow',
  cap_unknown_day: 'Daily intake limit for reports from senders this service does not know reached; try again tomorrow',
  cap_unknown_reporter_day: 'Daily intake limit for this sender reached; try again tomorrow',
  cap_unauth_day: 'Daily intake limit for this sender reached; try again tomorrow',
  cap_unauth_total_day: 'Daily intake limit for this address reached; try again tomorrow',
  over_cap_accepted_dropped: 'Accepted, not stored: over a daily limit',
  cap_workspace_day: 'Daily intake limit for this account reached; try again tomorrow',
  cap_instance_day: 'The service is receiving more reports than it can take today; try again tomorrow',
  cap_address_records: 'Daily report-record limit for this address reached; try again tomorrow',
  cap_workspace_storage: 'Report storage limit for this account reached',
  cap_instance_storage: 'The service has reached its report storage limit',
  no_attachment: 'No DMARC report attachment found',
  wrong_attachment_type: 'The attachment is not a DMARC aggregate report (expected zip, gzip or XML)',
  archive_invalid: 'The attachment could not be unpacked',
  decompressed_too_large: 'Report is too large once decompressed',
  xml_invalid: 'Invalid DMARC report',
  json_invalid: 'Invalid TLS-RPT report JSON',
  kind_mismatch_tlsrpt_to_rua: 'This is a TLS-RPT report; send it to the tls-rpt address, not the rua address',
  kind_mismatch_rua_to_tlsrpt: 'This is a DMARC aggregate report; send it to the rua address, not the tls-rpt address',
  too_many_records: 'Report has more records than this service accepts',
  field_too_long: 'Report contains a field longer than this service accepts',
  date_range_invalid: 'Report date range is not valid',
  domain_not_owned: 'Report is for a domain this address does not belong to',
  authserv_unconfigured: 'This service cannot authenticate senders yet; try again later',
  no_authentication_results: 'The message carries no authentication results from the receiving server',
  authserv_id_not_found: 'The message carries no authentication results from the receiving server',
  from_invalid: 'The message must have exactly one From address',
  not_authenticated: 'The sender could not be authenticated for the domain in its From address',
  storage_failed: 'Temporary storage failure; try again later',
  storage_failed_repeatedly: 'Report could not be stored after repeated attempts',
  not_configured: 'Hosted intake is not configured',
  schema_not_ready: 'Database schema is out of date',
  internal_error: 'Temporary failure; try again later',
} as const;

/** The refusal text for a message over the raw-size cap: "Report is larger than 10 MiB". */
export const rawTooLarge = (bytes: number) => `Report is larger than ${Math.floor(bytes / 1048576)} MiB`;

export type ReasonCode = keyof typeof REASONS;

/** A refusal with a specific reason; its SMTP text is REASONS[code] unless `detail` adds a fixed, non-reflective suffix. */
export class IntakeRefusal extends Error {
  constructor(readonly code: ReasonCode, readonly detail?: string) {
    super(detail ? `${REASONS[code]}: ${detail}` : REASONS[code]);
    this.name = 'IntakeRefusal';
  }
}

/** The reasons that mean "mail we could have stored but did not", shown to the owner as reports that were not processed. */
export const OWNER_VISIBLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'cap_address_day', 'cap_workspace_day', 'cap_instance_day', 'cap_address_records', 'cap_workspace_storage', 'cap_instance_storage',
  'storage_failed', 'storage_failed_repeatedly', 'over_cap_accepted_dropped', 'too_many_records', 'decompressed_too_large', 'raw_too_large',
]);
