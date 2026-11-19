## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `liumingjian/ftp-master` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Office Plugin

Office Plugin work for this system happens in `~/repos/wps-plugin` on branch `ftp-master`, packaged as its own extension with its own extension ID. The RoadFlow route on that repo's `master` stays untouched; ftp-master's ADR 0005 is the integration contract.
