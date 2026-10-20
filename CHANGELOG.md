# Changelog

## 0.2.0

- Correct the integration target to `google.google-antigravity`.
- Add a local activity stream and polling of reported model-call token metadata.
- Automatically time new whole requests and aggregate per-request and overall input/output tokens.
- Split multi-model request usage by model; display the active/latest reported model.
- Preserve counts across reconnects, accept late final metadata, and avoid replay after clearing or retention.
- Display connection state, unavailable data, and partial usage explicitly.
- Run in the workspace extension host for compatibility with remote Antigravity installations.

Experimental compatibility: official 1.8.0 package exports/schemas inspected; synthetic protocol and loopback HTTP tests pass. A signed-in Antigravity session still needs validation. Idle model-picker selection, separate subagent tokens, and quota are not included.

## 0.1.0

- Initial dashboard, manual request timers, event API, local token accounting, and JSON export.
