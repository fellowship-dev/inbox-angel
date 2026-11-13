-- What InboxAngel last read from live DNS for each domain, stored so the overview can show it without a lookup per card.
-- All columns are additive and nullable. Existing rows stay NULL: nothing has checked them yet.
--
-- dns_checked_at           unix seconds both SPF and DMARC were last read successfully. NULL: never.
-- dns_check_attempted_at   unix seconds of the last attempt, successful or not.
-- dns_check_status         result of the last attempt: 'ok', 'failed' (a lookup could not be answered; stored values
--                          were kept), or 'nxdomain' (DNS says the domain itself does not exist).
-- dmarc_issue              why the DMARC lookup gave no usable policy: 'multiple' (several records) or 'invalid'
--                          (no valid p=). NULL with dmarc_policy NULL after a check: there is no DMARC record.
-- dmarc_inherited_from     the organizational domain whose record covers this domain (RFC 7489), when it has none of
--                          its own. dmarc_policy is then that record's sp= (p= when sp is absent).
-- dns_last_good_status    'ok' or 'nxdomain': the status of the last check that read both SPF and DMARC (set together with
--                          dns_checked_at). A later failed attempt overwrites dns_check_status but not this, so a domain that
--                          did not resolve at its last good check is not shown with empty records after a failure.
ALTER TABLE domains ADD COLUMN dns_checked_at INTEGER;
ALTER TABLE domains ADD COLUMN dns_check_attempted_at INTEGER;
ALTER TABLE domains ADD COLUMN dns_check_status TEXT;
ALTER TABLE domains ADD COLUMN dmarc_issue TEXT;
ALTER TABLE domains ADD COLUMN dmarc_inherited_from TEXT;
ALTER TABLE domains ADD COLUMN dns_last_good_status TEXT;
