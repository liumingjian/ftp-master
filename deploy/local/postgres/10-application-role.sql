-- The service connects as ftp_master_app, a login role that owns nothing:
-- migrations run as the database owner and grant ftp_master_app only what the
-- application needs (for Audit Events: insert and select, never update or
-- delete). Run once by the PostgreSQL image on an empty data directory, and by
-- the integration tests. Production creates the same role with its own password.
CREATE ROLE ftp_master_app LOGIN PASSWORD 'ftp_master_app';
