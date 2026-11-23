-- +goose Up
CREATE TABLE office_edit_policy (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    enabled boolean NOT NULL DEFAULT true
);
INSERT INTO office_edit_policy DEFAULT VALUES;
GRANT SELECT, UPDATE ON office_edit_policy TO ftp_master_app;

-- +goose Down
DROP TABLE office_edit_policy;
