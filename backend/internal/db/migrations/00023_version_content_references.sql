-- +goose Up
-- Restoring appends metadata pointing at retained immutable content.
ALTER TABLE file_versions DROP CONSTRAINT file_versions_object_key_key;
CREATE INDEX file_versions_object_key ON file_versions(object_key);
-- +goose Down
-- Shared content references must be removed before rolling this migration back.
DROP INDEX file_versions_object_key;
ALTER TABLE file_versions ADD UNIQUE(object_key);
