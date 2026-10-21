# Roadmap

Requested additions and fixes, implemented in version 0.3.0.

## Requested additions

- [x] **Live model usage status:** provider-reported quota meters show percentage used/remaining, low/exhausted status, and reset countdowns. Model limits and shared limits are shown separately. Polling runs every 30 seconds, with manual refresh and stale/unavailable states.
- [x] **Monthly activity heatmap:** Daily activity uses a contributions-style monthly calendar in the existing color palette, with month navigation and day details. A diamond marks the subscription day every month, as requested; shorter months use their final day.

Enter the subscription start date from the dashboard or **Antigravity Usage: Set Subscription Start Date**. It is saved in global VS Code settings. The marker repeats monthly by default; an original-date-only option is also available. Quota data depends on the backend reporting it and remains independent of calendar preferences.

## Reported bugs

- [x] **Save interrupted-request duration:** a new question closes the previously running request at the new question's input time. Provider-reported interruptions use their reported timestamp. The saved duration survives reload and late token updates; interruption status and token accounting are preserved.

Historical interrupted rows without a stop timestamp and connection-only interruptions remain unknown rather than receiving an invented duration.
