-- +goose Up
-- Completed upload receipts outlive their retained versions.
ALTER TABLE upload_sessions DROP CONSTRAINT upload_sessions_version_id_fkey;
ALTER TABLE upload_batches ADD COLUMN created_at timestamptz;
-- Edit authority outlives retained version metadata. Snapshot the immutable
-- source for pending delivery and preserve format/base ID for delivered saves.
ALTER TABLE office_edit_permits ADD COLUMN object_key text NOT NULL DEFAULT '', ADD COLUMN size bigint NOT NULL DEFAULT 0, ADD COLUMN format text NOT NULL DEFAULT '';
UPDATE office_edit_permits p SET object_key=v.object_key,size=v.size,format=v.format FROM file_versions v WHERE v.id=p.version_id;
ALTER TABLE office_edit_permits DROP CONSTRAINT office_edit_permits_version_id_fkey;
-- Existing batches inherit their earliest intent; interrupted empty reservations
-- are conservatively aged from the first scheduler execution.
UPDATE upload_batches b SET created_at=(SELECT min(created_at) FROM upload_sessions u WHERE u.batch_id=b.id);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION audit_ensure_partition(at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE
 month_start timestamptz:=date_trunc('month',at);
 partition text:='audit_events_'||to_char(month_start,'YYYY_MM');
BEGIN
 PERFORM pg_advisory_xact_lock(725011);
 IF to_regclass('public.'||partition) IS NULL THEN
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',partition,month_start,month_start+interval '1 month');
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ftp_master_app',partition);
 END IF;
END $$;
-- +goose StatementEnd
-- Only direct children of the audit parent with canonical month names qualify;
-- retire an entire month only when its exclusive upper bound is <= cutoff.
-- +goose StatementBegin
CREATE FUNCTION audit_retire_partitions(at timestamptz) RETURNS void
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
END $$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION audit_retire_partitions(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_retire_partitions(timestamptz) TO ftp_master_app;
-- +goose Down
DROP FUNCTION audit_retire_partitions(timestamptz);
ALTER TABLE upload_batches DROP COLUMN created_at;
ALTER TABLE office_edit_permits DROP COLUMN object_key,DROP COLUMN size,DROP COLUMN format;
-- Receipts may already refer to pruned versions; do not recreate that FK.
