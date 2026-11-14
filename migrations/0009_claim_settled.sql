-- A claim that became a domain is kept (hidden) for a day, so a repeat verify of it finds the domain instead of a 404.
-- domain_claims.status is CHECKed to pending|lost and SQLite cannot alter a CHECK, so "settled" is two additive nullable columns.
--
-- settled_at         unix seconds the claim became a domain. NULL: still an open claim (every existing row).
-- settled_domain_id  the domains.id it became. No foreign key: removing the domain must not touch the row, and the verify route
--                    answers 200 only while that id is still a live domain of the same workspace and name.
ALTER TABLE domain_claims ADD COLUMN settled_at INTEGER;
ALTER TABLE domain_claims ADD COLUMN settled_domain_id INTEGER;
