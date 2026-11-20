-- The service connects as ftp_master_app and owns nothing; migrations run as
-- the database owner and grant it, table by table, only what it needs. There
-- are no default privileges: a table the role may use says so explicitly.
-- The login role is normally created beforehand by whoever provisions the
-- database (deploy/local/postgres/10-application-role.sql locally); it is
-- created here without login only so migrations never fail on its absence.

-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ftp_master_app') THEN
        CREATE ROLE ftp_master_app NOLOGIN;
    END IF;
END
$$;
-- +goose StatementEnd

-- The health check reads the applied schema version.
GRANT SELECT ON goose_db_version TO ftp_master_app;

-- +goose Down
REVOKE SELECT ON goose_db_version FROM ftp_master_app;
