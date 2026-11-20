-- +goose Up
CREATE INDEX audit_events_item_occurred_at ON audit_events (item_id, occurred_at);
-- +goose Down
DROP INDEX audit_events_item_occurred_at;
