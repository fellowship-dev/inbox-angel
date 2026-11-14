-- When a hosted domain's reports were connected to the fixed report address (rua@<INTAKE_DOMAIN>).
--
-- reports_connected_at  unix seconds of the current connection. NULL: not connected, or connected before this column
--                       existed (the dashboard then counts no report as "received since connecting" until it is
--                       reconnected). Set by POST /api/domains/:id/report-address, cleared by DELETE.
ALTER TABLE domains ADD COLUMN reports_connected_at INTEGER;
