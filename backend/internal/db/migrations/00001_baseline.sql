-- Baseline: starts the ordered migration history. Domain tables arrive with
-- the tickets that introduce them, each as the next numbered migration.

-- +goose Up
SELECT 1;

-- +goose Down
SELECT 1;
