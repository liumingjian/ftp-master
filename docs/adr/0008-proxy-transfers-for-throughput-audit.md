# File transfers stream through the application for authoritative throughput audit

Partially supersedes [ADR 0003](./0003-three-host-symmetric-deployment.md), which routed large-file uploads and downloads directly between browsers and MinIO via presigned URLs.

Administrators need to inspect real per-second network throughput and interruption curves for `upload`, `download`, and `zip_download` operations when diagnosing network bottlenecks or faults. Because single-file downloads via 302 redirects and direct-to-MinIO uploads never pass file bytes through the Go application, the server cannot observe real transfer rates or detect mid-transfer disconnects, and browsers cannot reliably measure native `<a download>` streams or report telemetry after a network drop.

All file transfer data — upload parts, single-file downloads (with HTTP Range support), and zip downloads — now streams through the Go application service to and from MinIO using small in-memory buffers without disk spooling. Because each of the three symmetric hosts already collocates Nginx, the Go service, and MinIO, the extra hop stays on the same cluster while giving the server a single authoritative measurement point for every transfer's per-second throughput and completion or failure outcome.

## Considered Options

- **Hybrid (proxy downloads only; browser-reported upload samples)**: Keeps upload parts bypassing Go, but leaves upload throughput client-reported (untrusted, different measurement layer from downloads) and loses upload curves whenever a network failure prevents the browser from reporting back.
- **Pure browser-side measurement (keep ADR 0003 intact)**: Requires replacing native `<a download>` with `fetch` + `ReadableStream` or File System Access API, which degrades 20 GB download reliability and compatibility in enterprise browsers such as QAXBrowser.

## Consequences

- Single-file `download` Audit Events are no longer written at redirect time; instead, every `upload`, `download`, and `zip_download` writes an immutable Audit Event upon completion (`success`) or interruption/failure (`failure`).
- Nginx and Go HTTP proxy timeouts, body-size limits, and streaming flush settings must accommodate long-running 20 GB transfers and concurrent streams on the three-host deployment.
- Presigned URLs are no longer exposed to browsers for file transfer data paths.
