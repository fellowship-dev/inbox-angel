// The documented defaults (docs/hosted.md, "Limits and caps"), pinned: a change here is a change to the published numbers.
import { describe, it, expect } from 'vitest';
import { intakeLimits } from '../../src/hosted/config';
import { retentionPolicy } from '../../src/lifecycle/config';
import { reportCounting } from '../../src/dmarc/counting';

const MiB = 1024 * 1024;

describe('intake limits: hosted defaults', () => {
  it('every cap and its default', () => {
    expect(intakeLimits({ MODE: 'saas' })).toEqual({
      reportsPerDay: 50, bytesPerDay: 50 * MiB, reportersPerDay: 100,
      recordsPerReport: 5_000, newIpsPerReport: 50,
      unauthReportsPerDay: 10, unauthBytesPerDay: 26_214_400, unauthSendersPerDay: 5, unauthTotalReportsPerDay: 25, unauthRecordsPerReport: 1_000,
      totalReportsPerDay: 1_000, totalBytesPerDay: 1024 * MiB,
      addressMessagesPerDay: 500, addressRecordsPerDay: 200_000,
      workspaceMessagesPerDay: 2_000, workspaceRecords: 1_000_000,
      instanceMessagesPerDay: 50_000, instanceRecords: 10_000_000,
      maxDecompressedBytes: 3 * MiB, maxRawBytes: 10 * MiB, storageRetriesPerDay: 20,
    });
  });

  it('each variable overrides its own cap; garbage and non-positive values fall back', () => {
    const env = { MODE: 'saas', INTAKE_MAX_ADDRESS_MESSAGES_PER_DAY: '7', INTAKE_MAX_WORKSPACE_RECORDS: '123', INTAKE_MAX_INSTANCE_RECORDS: 'x', INTAKE_MAX_UNAUTH_TOTAL_REPORTS_PER_DAY: '-1', INTAKE_MAX_RAW_BYTES: String(99 * MiB), INTAKE_MAX_DECOMPRESSED_BYTES: String(99 * MiB) };
    expect(intakeLimits(env)).toMatchObject({ addressMessagesPerDay: 7, workspaceRecords: 123, instanceRecords: 10_000_000, unauthTotalReportsPerDay: 25, maxRawBytes: 25 * MiB, maxDecompressedBytes: 25 * MiB }); // never above Cloudflare's 25 MiB
  });
});

describe('self-host: generous but bounded', () => {
  it('records, decompressed size and enrichment are capped too; there are no daily caps to hit (they apply to hosted intake)', () => {
    expect(intakeLimits({})).toMatchObject({ recordsPerReport: 10_000, newIpsPerReport: 200, maxDecompressedBytes: 6 * MiB, maxRawBytes: 10 * MiB });
  });
});

describe('retention and counting defaults', () => {
  it('counters 8 days, failure markers 90 days, reports 13 months', () => {
    expect(retentionPolicy({})).toMatchObject({ intakeCounterDays: 8, intakeFailureDays: 90, reportsDays: 395 });
    expect(retentionPolicy({ RETENTION_INTAKE_COUNTERS_DAYS: '3', RETENTION_INTAKE_FAILURES_DAYS: '30' })).toMatchObject({ intakeCounterDays: 3, intakeFailureDays: 30 });
  });
  it('REPORT_COUNTING: proven hosted, all self-host', () => {
    expect([reportCounting({ MODE: 'saas' }), reportCounting({})]).toEqual(['proven', 'all']);
  });
});
