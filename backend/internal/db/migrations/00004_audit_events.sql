-- Audit Events: append-only, partitioned by month of occurred_at (UTC).
--
-- The application role may insert and select, nothing else, so neither the
-- service nor anything that subverts it can change or delete the record.
-- Partitions are created by audit_ensure_partition, which runs with the
-- owner's rights; partitions carry no grants, so they cannot be reached
-- directly, only through the parent table's insert and select.

-- +goose Up
CREATE TABLE audit_events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    -- Who acted: the User's id when known, and always the username at the
    -- time (for a failed sign-in, the name that was tried).
    user_id     bigint,
    username    text NOT NULL,
    source_ip   inet,
    action      text NOT NULL,
    outcome     text NOT NULL CHECK (outcome IN ('success', 'failure')),
    -- The item acted on and its path at the time, for actions on items.
    item_id     bigint,
    item_path   text,
    detail      jsonb NOT NULL DEFAULT '{}'
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_events_occurred_at ON audit_events (occurred_at);
CREATE INDEX audit_events_user_occurred_at ON audit_events (user_id, occurred_at);
CREATE INDEX audit_events_item_path ON audit_events (item_path text_pattern_ops);

REVOKE ALL ON audit_events FROM PUBLIC;
GRANT SELECT, INSERT ON audit_events TO ftp_master_app;

-- +goose StatementBegin
CREATE FUNCTION audit_ensure_partition(at timestamptz) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET timezone = 'UTC'
AS $$
DECLARE
    month_start timestamptz := date_trunc('month', at);
    partition   text := 'audit_events_' || to_char(month_start, 'YYYY_MM');
BEGIN
    IF to_regclass('public.' || partition) IS NOT NULL THEN
        RETURN;
    END IF;
    EXECUTE format(
        'CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
        partition, month_start, month_start + interval '1 month');
    -- Explicit, so that default privileges the owner may have never reach
    -- the application role.
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ftp_master_app', partition);
EXCEPTION
    -- Another instance created it at the same moment.
    WHEN duplicate_table THEN NULL;
END
$$;
-- +goose StatementEnd

REVOKE ALL ON FUNCTION audit_ensure_partition(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_ensure_partition(timestamptz) TO ftp_master_app;

-- +goose Down
DROP FUNCTION audit_ensure_partition(timestamptz);
DROP TABLE audit_events;
