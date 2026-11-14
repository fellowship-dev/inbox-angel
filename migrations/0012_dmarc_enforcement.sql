-- How much of a DMARC policy is enforced, read with the policy, so the overview can tell full enforcement from partial.
-- Additive and nullable. Existing rows stay NULL until their next DNS read: the overview then says the enforcement level
-- is not known yet instead of calling a domain enforced. (Numbered 0012: open branches use 0010 and 0011.)
--
-- dmarc_sp   sp= of the record that applies (the domain's own record, else the covering parent's), lower-cased; the
--            record's p= when it has no sp= tag. Written by every DNS check that reads DMARC.
-- The existing nullable domains.dmarc_pct column (never written for domains before) now holds pct= from the same read
-- (100 when the record has no pct= tag).
ALTER TABLE domains ADD COLUMN dmarc_sp TEXT;
