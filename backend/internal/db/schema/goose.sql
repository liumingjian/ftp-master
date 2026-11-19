-- The migration-history table goose creates and maintains. Declared here only
-- so sqlc can type-check queries against it; never applied as a migration.
CREATE TABLE goose_db_version (
    id         serial PRIMARY KEY,
    version_id bigint NOT NULL,
    is_applied boolean NOT NULL,
    tstamp     timestamp DEFAULT now()
);
