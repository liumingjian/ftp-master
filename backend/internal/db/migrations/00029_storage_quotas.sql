-- Hierarchical Storage Quotas on Organizations and Users (ADR 0010).

-- +goose Up
ALTER TABLE organizations
    ADD COLUMN quota_bytes bigint CHECK (quota_bytes IS NULL OR quota_bytes >= 0);

ALTER TABLE users
    ADD COLUMN quota_bytes bigint CHECK (quota_bytes IS NULL OR quota_bytes >= 0);

GRANT UPDATE (quota_bytes) ON users TO ftp_master_app;

CREATE INDEX file_versions_object_key_id ON file_versions (object_key, id);
CREATE INDEX upload_sessions_active_owner ON upload_sessions (owner_id) WHERE state <> 'complete';

-- +goose Down
DROP INDEX upload_sessions_active_owner;
DROP INDEX file_versions_object_key_id;
REVOKE UPDATE (quota_bytes) ON users FROM ftp_master_app;
ALTER TABLE users DROP COLUMN quota_bytes;
ALTER TABLE organizations DROP COLUMN quota_bytes;
