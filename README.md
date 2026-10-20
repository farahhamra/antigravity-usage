# Antigravity Usage

A VS Code extension for tracking model activity, input/output tokens, and the full duration of an agent request, with a compact dashboard inspired by Claude's usage views.

**Development preview:** the dashboard, tracking engine, manual timers, and integration event API are implemented. Automatic collection from `gogle.google-antigravity` is **not implemented yet**. Its API or log format must be verified first. Installing this extension alone does not reveal Antigravity's tokens, selected model, quota, or account history.

## Features

- Overall recorded input and output tokens, with totals preserved beyond detailed-history retention.
- Per-request input/output tokens, model, start time, duration, status, and data source.
- Live cumulative token counts and elapsed time for the selected model when an adapter supplies events.
- Manual request timers: start when you send the prompt and finish when the agent finishes its whole response.
- Daily activity, per-model comparisons, date filters, and completed/failed/cancelled/interrupted outcomes.
- Provider-reported USD cost when available; no guessed prices.
- Local storage, JSON export, and confirmed history deletion.

Missing token counts display **—**, rather than zero. Partial totals show how many requests reported usage. Zero means the provider explicitly reported zero. Overall totals mean activity recorded since tracking began, not your provider's historical account usage. A request may include multiple model calls and tool steps; an adapter must aggregate those into the entire agent turn.

## Develop

Requires Node.js 22 or later and VS Code 1.95 or later.

```sh
npm ci
npm run check
npm test
npm run compile
```

Open this folder in VS Code and press **F5** to launch an Extension Development Host. Run **Antigravity Usage: Open Dashboard** from the Command Palette. Use **Select Model for Manual Timer**, **Start Manual Request Timer**, and **Finish Manual Request Timer** to exercise the timer.

For incremental compilation, run `npm run watch`.

```sh
npm run package
```

This produces `artifacts/antigravity-usage.vsix`. In VS Code, use **Extensions: Install from VSIX...** to install it locally. This does not publish anything to the Marketplace. The `farahhamra` publisher name is a local packaging identifier; Marketplace publisher ownership has not been verified.

Tests cover request lifecycles, cumulative tokens, duplicate events, model switching, invalid data, retention, persistence, and the actual dashboard DOM. Cloud validation does not replace a real VS Code/Antigravity integration test.

## Connect Antigravity

The requested target is **`gogle.google-antigravity`**. The dashboard checks whether that exact extension ID is installed.

Run **Antigravity Usage: Inspect Antigravity Integration** on the machine where the target is installed. The output lists its installed version, active state, and public API key names if available. It does not activate the target, call its API, or inspect prompts, credentials, or private state.

The next implementation step is an adapter using a documented API, or a verified local log format that contains:

1. Model selection.
2. Start of a whole user request.
3. Cumulative input/output token usage during that request, if available.
4. Completion, failure, or cancellation after all tool calls finish.

If the target only reports final counts, final usage can be accurate but live usage cannot be promised. Subscription quota and reset times require separate provider data.

### Adapter API

Another VS Code extension can feed verified events into this extension:

```ts
const extension = vscode.extensions.getExtension('farahhamra.antigravity-usage');
if (!extension) throw new Error('Install Antigravity Usage first.');
const usage = await extension.activate();
if (usage.version !== 1) throw new Error('Unsupported usage API.');

await usage.record({ type: 'model', model: selectedModel });
await usage.record({
  type: 'start', requestId, model: selectedModel, at: requestStartedAt,
});
await usage.record({
  type: 'usage', requestId, at: Date.now(),
  inputTokens: cumulativeInputTokens,
  outputTokens: cumulativeOutputTokens,
});
await usage.record({
  type: 'finish', requestId, at: responseFinishedAt, status: 'completed',
  inputTokens: finalInputTokens,
  outputTokens: finalOutputTokens,
});
```

This is an integration contract for a future adapter, not an API claimed to exist in Antigravity. No adapter is bundled.

- Timestamps are Unix milliseconds. Events for a request must arrive in time order.
- Request IDs must be unique. Identical starts and finishes are idempotent while their detail records are retained. Do not replay archived requests.
- Token updates are **cumulative**, non-negative integers, not increments. Counts cannot decrease.
- Optional `costUsd` is a cumulative non-negative number from the provider.
- Missing fields preserve previous counts. Omit fields that the provider does not report.
- `finish.status` supports `completed`, `failed`, and `cancelled`.
- The API validates events and rejects invalid transitions without partially changing usage.
- Multiple requests can run concurrently. Each stays attributed to its original model.
- A start event selects that request's model; a later `model` event can change the displayed selection.

## Data and limitations

Usage is stored in VS Code's local extension global state and is shared across workspaces in the same profile. It is not sent to a server or registered for Settings Sync. The extension makes no network requests and collects no prompts or responses. Multiple independent VS Code windows do not currently coordinate writes; use one tracking window per profile.

The latest 1,000 finished requests and up to 100 active requests are retained. Overall token and request totals survive pruning. Date-filtered charts and per-model comparisons cover the retained details. Clearing history resets the details and overall totals.

After a VS Code restart, unfinished requests become **interrupted**. Their known tokens are preserved, but a completion time is not invented. Corrupt saved history is preserved until explicitly cleared.

Ideas for later: quota/reset indicators, usage alerts, cost estimates with configurable prices, and workspace/session breakdowns—each depending on available provider data.
