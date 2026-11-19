# Audit is a simple Administrator-only event log, filtered by path at the time

Audit Events are read on one page, by Administrators only. It is a flat log with a filter bar (time range to the minute, at most 180 days; one or more Users, or an Organization and everyone beneath it; a directory; action category; failures only), a paged table and a detail drawer offering "only this person", "only this directory" and "this item's whole history". Results export as CSV. We rejected an investigation console (histograms, per-person lanes, trace chains with evidence pinning, a query language, grouping by sign-in session) and a delegated view for holders of the Grant Right on a directory: the need is to find quickly who did what and when, and every extra surface is something to build, test and explain.

The directory filter is a prefix match on the item's **path at the time of the event**, with "include subdirectories" on by default. It maps to one indexed predicate and is predictable, at the cost that after a directory is renamed or moved its older events are found under the old path; the path suggestions include paths that no longer exist, marked as such. Following an item across renames and moves is done by its stable id ("this item's whole history"), not by the directory filter. We rejected matching by current location, which needs the subtree's item ids resolved first and has no answer for deleted or purged items.

What is recorded is narrowed: previews are not recorded, a zip download is one event listing the files it packed (it matches a directory if any packed file was under it at the time), and exporting audit results is not itself recorded.

## Consequences

- Spec story 72 (department heads query their own area) is withdrawn; story 73 becomes "all Audit Events are Administrator-only". No 等保 separate audit-administrator role yet.
- The Audit Event needs a file list for zip downloads (in its detail); the table needs indexes on time, on User and time, and on path for prefix matching.
- Design evidence: prototype branch `prototype/file-browser`, variant `S1` (`prototypes/file-browser/src/VariantSimple.tsx`, `querySimple` in `audit.ts`).
