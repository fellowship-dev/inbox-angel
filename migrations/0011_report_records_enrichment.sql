-- Migration 0011: IP enrichment on report records (was ensureMigrated v10).
ALTER TABLE report_records ADD COLUMN reverse_dns TEXT;
ALTER TABLE report_records ADD COLUMN base_domain TEXT;
ALTER TABLE report_records ADD COLUMN country_code TEXT;
ALTER TABLE report_records ADD COLUMN org TEXT;
