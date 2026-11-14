-- Ready Set Mail demo data cleanup
-- Removes all data seeded by scripts/seed-demo.ts (demo domains)
-- Safe to run multiple times.

DELETE FROM report_records   WHERE report_id IN (SELECT id FROM aggregate_reports WHERE domain_id IN (SELECT id FROM domains WHERE domain IN ('acme.com', 'getacme.com', 'acme-mail.com')));
DELETE FROM aggregate_reports WHERE domain_id IN (SELECT id FROM domains WHERE domain IN ('acme.com', 'getacme.com', 'acme-mail.com'));
DELETE FROM domains          WHERE domain IN ('acme.com', 'getacme.com', 'acme-mail.com');
