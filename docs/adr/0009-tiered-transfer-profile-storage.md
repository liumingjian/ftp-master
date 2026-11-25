# Tiered storage and downsampling for Transfer Profiles

Each transfer Audit Event (`upload`, `download`, `zip_download`) needs both a lightweight trend indicator in the paged audit table and a detailed per-second throughput curve in the detail view. Because `QueryAuditEvents` reads full `audit_events` rows (and CSV export scans up to 180 days at once), while a 20 GB transfer over a 1 MB/s link can span more than 5 hours (20,000+ seconds), embedding full per-second arrays directly in `audit_events.detail` would bloat table scans, pagination payloads, and CSV exports.

Transfer Profile data is split into two tiers:

1. **Summary and sparkline in `audit_events.detail`**: Compact fields (`bytesTransferred`, `totalBytes`, `durationMs`, `activeDurationMs`, `avgBps`, `peakBps`, `minBps`, `anomaly`, `statusReason`, optional byte `range`) plus a bounded `sparkline` array of at most 24 buckets. List rendering and CSV export read only `audit_events` with zero extra queries.
2. **Full time-series in a companion monthly-partitioned append-only table** (`audit_transfer_series`): Loaded on demand by event id when an Administrator clicks a transfer's sparkline (or trend launcher) to open the dedicated throughput trend window, and retired on the same 180-day monthly partition drop schedule as `audit_events`. Transfers up to 1 hour (3,600 seconds) retain exact 1-second resolution; longer transfers coarsen bucket width (for example 5-second or 10-second buckets, capped near 3,600 points) and record their bucket interval so the chart labels the actual resolution.

For multipart resumable uploads across the three symmetric hosts, per-part samples accumulate in shared temporary storage keyed by upload session and merge into one Transfer Profile on completion, collapsing pause gaps longer than 10 seconds with explicit gap markers so multi-hour pauses do not flatten active transfer curves. Mid-stream part failures immediately emit a failed `upload` Audit Event with the samples collected up to the disconnect; expired incomplete sessions that already transferred more than 0 bytes emit a failed (`abandoned`) `upload` Audit Event upon scheduled cleanup, while 0-byte sessions expire silently.

## Considered Options

- **Store raw per-second arrays inside `audit_events.detail`**: Simpler schema, but degrades 180-day list queries and CSV exports and creates large JSONB TOAST bloat on every large transfer.
- **Store time-series in an external TSDB (e.g. Prometheus/InfluxDB)**: Adds a new stateful service to operate across the three symmetric hosts of ADR 0003 and weakens atomic 180-day retention alignment with `audit_events`.

## Consequences

- `audit_ensure_partition` and `audit_retire_partitions` must manage partitions for both `audit_events` and `audit_transfer_series` in lockstep.
- CSV export outputs only summary metrics from `audit_events.detail` and never includes raw per-second arrays.
- Detail views need a dedicated endpoint (or detail fetch) to load the time-series points when a transfer row is opened.
