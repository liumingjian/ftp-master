-- Transfer Profiles: tiered storage (ADR 0009) and transient cross-host upload
-- part samples (ADR 0008).

-- +goose Up
CREATE TABLE audit_transfer_series (
    event_id       bigint NOT NULL,
    occurred_at    timestamptz NOT NULL,
    bucket_seconds integer NOT NULL CHECK (bucket_seconds >= 1),
    points         jsonb NOT NULL,
    gaps           jsonb NOT NULL DEFAULT '[]',
    PRIMARY KEY (occurred_at, event_id)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_transfer_series_event_id ON audit_transfer_series (event_id);

REVOKE ALL ON audit_transfer_series FROM PUBLIC;
GRANT SELECT, INSERT ON audit_transfer_series TO ftp_master_app;

-- Shared temporary buffer for multipart upload samples across the three symmetric hosts.
CREATE TABLE upload_transfer_samples (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id        text NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    part_number       integer NOT NULL CHECK (part_number >= 1),
    started_at        timestamptz NOT NULL,
    ended_at          timestamptz NOT NULL,
    bytes_transferred bigint NOT NULL CHECK (bytes_transferred >= 0),
    samples           jsonb NOT NULL
);

CREATE INDEX upload_transfer_samples_session ON upload_transfer_samples (session_id, started_at, id);

REVOKE ALL ON upload_transfer_samples FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON upload_transfer_samples TO ftp_master_app;
GRANT USAGE, SELECT ON SEQUENCE upload_transfer_samples_id_seq TO ftp_master_app;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION audit_ensure_partition(at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE
 month_start timestamptz:=date_trunc('month',at);
 suffix text:=to_char(month_start,'YYYY_MM');
 ev_partition text:='audit_events_'||suffix;
 ts_partition text:='audit_transfer_series_'||suffix;
BEGIN
 PERFORM pg_advisory_xact_lock(725011);
 IF to_regclass('public.'||ev_partition) IS NULL THEN
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',ev_partition,month_start,month_start+interval '1 month');
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ftp_master_app',ev_partition);
 END IF;
 IF to_regclass('public.'||ts_partition) IS NULL THEN
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_transfer_series FOR VALUES FROM (%L) TO (%L)',ts_partition,month_start,month_start+interval '1 month');
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ftp_master_app',ts_partition);
 END IF;
END $$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION audit_retire_partitions(at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE p record; month_start timestamptz;
BEGIN
 PERFORM pg_advisory_xact_lock(725011);
 FOR p IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='public.audit_events'::regclass AND c.relnamespace='public'::regnamespace LOOP
  IF p.relname ~ '^audit_events_[0-9]{4}_[0-9]{2}$' THEN
   month_start:=to_date(substring(p.relname FROM 14),'YYYY_MM')::timestamptz;
   IF month_start+interval '1 month' <= at-interval '180 days' THEN
    EXECUTE format('DROP TABLE public.%I',p.relname);
   END IF;
  END IF;
 END LOOP;
 FOR p IN SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='public.audit_transfer_series'::regclass AND c.relnamespace='public'::regnamespace LOOP
  IF p.relname ~ '^audit_transfer_series_[0-9]{4}_[0-9]{2}$' THEN
   month_start:=to_date(substring(p.relname FROM 23),'YYYY_MM')::timestamptz;
   IF month_start+interval '1 month' <= at-interval '180 days' THEN
    EXECUTE format('DROP TABLE public.%I',p.relname);
   END IF;
  END IF;
 END LOOP;
END $$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE upload_transfer_samples;
DROP TABLE audit_transfer_series;
