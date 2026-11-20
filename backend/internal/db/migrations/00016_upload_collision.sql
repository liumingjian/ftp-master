-- +goose Up
ALTER TABLE upload_sessions ADD COLUMN collision text NOT NULL DEFAULT '' CHECK(collision IN ('','new_version','keep_both'));
-- +goose Down
ALTER TABLE upload_sessions DROP COLUMN collision;
