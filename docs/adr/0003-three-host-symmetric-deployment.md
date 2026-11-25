# Three symmetric hosts, file bytes bypass the application

Version 1 deploys directly on at least three hosts (no Kubernetes); each host runs the same set: Nginx + keepalived (floating virtual IP), a stateless application instance, a MinIO node in one distributed erasure-coded cluster, PostgreSQL managed by Patroni with etcd, and Redis with Sentinel. The goal is that losing any one host does not interrupt service; cross-datacenter recovery is out of scope.

Large-file speed originally came from browsers uploading and downloading directly to MinIO via presigned URLs, using multipart, resumable uploads; the application only authorized, recorded metadata and wrote Audit Events, so file bytes never passed through it. **This direct-to-MinIO bypass is superseded by [ADR 0008](./0008-proxy-transfers-for-throughput-audit.md)**, which streams upload parts and single-file downloads through the Go application so the server can authoritatively audit per-second transfer throughput and mid-transfer failures. Two bounded exceptions already streamed through the application: zip downloads of multiple items (capped at 10 GB) and Office editing (files up to 25 MiB, see ADR 0005).

## Consequences

- Usable capacity is roughly two thirds of raw disk under erasure coding; 10 TB usable needs about 15 TB raw or more, plus headroom for File Versions and the Recycle Bin.
- High availability is not backup: replicas and erasure coding do not protect against accidental or malicious deletion beyond what File Versions and the Recycle Bin retain.
- Backup scope for version 1: PostgreSQL gets a daily base backup plus WAL archiving (point-in-time recovery within 7 days), stored off the three hosts (e.g. a NAS). File content has no off-site backup; losing the whole site loses files. This is an accepted risk.
