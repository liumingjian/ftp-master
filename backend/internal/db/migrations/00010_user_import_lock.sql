-- +goose Up
-- A column-scoped UPDATE grant cannot acquire this table lock directly.
-- The fixed, no-argument function exposes only serialization, not writes.
-- +goose StatementBegin
CREATE FUNCTION lock_user_import() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
END;
$$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION lock_user_import() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_user_import() TO ftp_master_app;

-- +goose Down
DROP FUNCTION lock_user_import();
