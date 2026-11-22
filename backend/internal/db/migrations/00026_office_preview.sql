-- +goose Up
ALTER TABLE office_edit_permits ADD COLUMN preview boolean NOT NULL DEFAULT false;

-- +goose Down
DELETE FROM office_edit_permits WHERE preview;
ALTER TABLE office_edit_permits DROP COLUMN preview;
