# Roadmap

Saved for future development at the user's request. These additions and fixes are planned and have not been implemented.

## Requested additions

- [ ] **Live model usage status:** add per-model usage status indicators inspired by the usage displays in Claude Code or Codex.
- [ ] **Monthly activity heatmap:** redesign Daily activity as a GitHub contributions-style calendar, displayed one month at a time. Preserve the extension's existing color palette and add a distinct indicator on the date the subscription started.

When implementing, confirm which usage/status metrics Antigravity exposes and how the subscription start date should be supplied.

## Reported bugs

- [ ] **Save interrupted-request duration:** when the user sends another question while the agent is still working, the original request is correctly marked **interrupted**, and its tokens are correctly saved, but its elapsed time is not saved. Preserve the original request's elapsed duration up to the interruption and show it in history after a reload. Keep the working interruption detection and token accounting intact; the interrupted timer should stop rather than continue increasing.
