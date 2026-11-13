-- When InboxAngel last read this domain's live SPF and DMARC from DNS and stored both answers
-- (unix seconds). NULL: never. Existing rows stay NULL: nothing has checked them yet.
ALTER TABLE domains ADD COLUMN dns_checked_at INTEGER;
