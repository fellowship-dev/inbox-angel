// The documented defaults (docs/hosted.md, "Limits and caps"), pinned: a change here is a change to the published numbers.
import { describe, it, expect } from 'vitest';
import { intakeLimits } from '../../src/hosted/config';
import { retentionPolicy } from '../../src/lifecycle/config';
import { reportCounting } from '../../src/dmarc/counting';

const MiB = 1024 * 1024;

describe('intake limits: hosted defaults', () => {
  it('every cap and its default', () => {
    expect(intakeLimits({ MODE: 'saas' })).toEqual({
      reportsPerDay: 50, recordsPerReport: 2_000, bytesPerDay: 50 * MiB, newIpsPerReport: 50,
      unknownReportsPerReporterPerDay: 5, unknownReportsPerDay: 20, unknownRecordsPerReport: 1_000, unknownNewIpsPerReport: 10,
      unauthReportsPerDay: 5, unauthBytesPerDay: 10 * MiB, unauthTotalReportsPerDay: 10, unauthRecordsPerReport: 200,
      nonRegistryDecompressedBytes: 1 * MiB,
      uncountedWorkspaceMessagesPerDay: 100, uncountedInstanceMessagesPerDay: 2_000, uncountedAddressRecordsPerDay: 5_000, uncountedWorkspaceRecords: 20_000, uncountedInstanceRecords: 500_000,
      addressMessagesPerDay: 500, addressRecordsPerDay: 200_000,
      workspaceMessagesPerDay: 2_000, workspaceRecords: 1_000_000,
      instanceMessagesPerDay: 50_000, instanceRecords: 10_000_000,
      maxDecompressedBytes: 1 * MiB, maxRawBytes: 2 * MiB, storageRetriesPerDay: 20,
    });
  });

  it('each variable overrides its own cap; garbage and non-positive values fall back', () => {
    const env = { MODE: 'saas', INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '7', INTAKE_MAX_WORKSPACE_RECORDS: '123', INTAKE_MAX_INSTANCE_RECORDS: 'x', INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY: '-1', INTAKE_MAX_RAW_BYTES: String(99 * MiB), INTAKE_MAX_DECOMPRESSED_BYTES: String(99 * MiB) };
    expect(intakeLimits(env)).toMatchObject({ addressMessagesPerDay: 7, workspaceRecords: 123, instanceRecords: 10_000_000, unauthTotalReportsPerDay: 10, maxRawBytes: 25 * MiB, maxDecompressedBytes: 25 * MiB }); // never above Cloudflare's 25 MiB
  });
});

describe('self-host: generous but bounded', () => {
  it('records, decompressed size and enrichment are capped too; there are no daily caps to hit (they apply to hosted intake)', () => {
    expect(intakeLimits({})).toMatchObject({ recordsPerReport: 2_500, newIpsPerReport: 200, maxDecompressedBytes: 1.25 * MiB, maxRawBytes: 2 * MiB });
  });
});

describe('retention and counting defaults', () => {
  it('counters 8 days, failure markers 90 days, reports 13 months', () => {
    expect(retentionPolicy({})).toMatchObject({ intakeCounterDays: 8, intakeFailureDays: 90, reportsDays: 395 });
    expect(retentionPolicy({ RETENTION_INTAKE_COUNTERS_DAYS: '3', RETENTION_INTAKE_FAILURES_DAYS: '30' })).toMatchObject({ intakeCounterDays: 3, intakeFailureDays: 30 });
  });
  it('uncounted reports (unknown and unauthenticated tiers) are kept 30 days; the new name wins, the old one is still honoured', () => {
    expect(retentionPolicy({})).toMatchObject({ uncountedReportsDays: 30 });
    expect(retentionPolicy({ RETENTION_UNAUTHENTICATED_REPORTS_DAYS: '10' })).toMatchObject({ uncountedReportsDays: 10 });
    expect(retentionPolicy({ RETENTION_UNAUTHENTICATED_REPORTS_DAYS: '10', RETENTION_UNCOUNTED_REPORTS_DAYS: '7' })).toMatchObject({ uncountedReportsDays: 7 });
    expect(retentionPolicy({ RETENTION_UNCOUNTED_REPORTS_DAYS: 'x', RETENTION_UNAUTHENTICATED_REPORTS_DAYS: '12' })).toMatchObject({ uncountedReportsDays: 12 });
  });
  it('REPORT_COUNTING: registry hosted, all self-host', () => {
    expect([reportCounting({ MODE: 'saas' }), reportCounting({})]).toEqual(['registry', 'all']);
  });
});
