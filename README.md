# Antigravity Usage

A VS Code extension for tracking model activity, input/output tokens, and the full duration of an agent request, with a compact dashboard inspired by Claude's usage views.

**0.2 preview:** automatic activity tracking is now implemented for [Google Antigravity](https://marketplace.visualstudio.com/items?itemName=Google.google-antigravity), extension ID **`google.google-antigravity`**. It observes the extension's local backend and reads reported model-call usage. The connection exports and data schemas were inspected in Google's verified 1.8.0 package; automated tests use a local protocol fixture. A signed-in Antigravity session has **not** been tested in the cloud environment. These local interfaces are not a documented, stable Google extension API.

## Features

- Overall recorded input and output tokens, with totals preserved beyond detailed-history retention.
- Per-request input/output tokens, model, start time, duration, status, and data source.
- Automatic whole-request timing and cumulative reported input/output tokens, refreshed approximately every three seconds.
- Active/latest request model, with usage split by model when a turn uses several models.
- Manual request timers: start when you send the prompt and finish when the agent finishes its whole response.
- Daily activity, per-model comparisons, date filters, and completed/failed/cancelled/interrupted outcomes.
- Provider-reported USD cost when available; no guessed prices.
- Local storage, JSON export, and confirmed history deletion.

Missing token counts display **—**, rather than zero. Partial totals show coverage and incomplete metadata. Zero means the provider explicitly reported zero. Overall totals cover observed top-level requests since tracking began, not historical account usage or separate subagent conversations. Multiple model calls and tool steps are grouped into their user turn using Antigravity's step indices.

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

Tests cover the local HTTP/Connect protocol, request lifecycles, delayed metadata, token accounting across turns and models, reconnects, invalid data, retention, persistence, and the actual dashboard DOM. Cloud validation does not replace a real VS Code/Antigravity integration test.

## Connect Antigravity

1. Install the latest VSIX from [GitHub Releases](https://github.com/farahhamra/antigravity-usage/releases), then reload VS Code.
2. Install/open **Google.google-antigravity** in the same extension host. In SSH, WSL, or a container, install both extensions on the workspace side.
3. Run **Antigravity Usage: Open Dashboard**. Wait for **Live Antigravity activity connected**.
4. Send a **new** request in Antigravity. Its timer begins at the reported user-input time and ends when Antigravity reports the turn idle, including its tool work and active-child waiting time.
5. Tokens appear when the backend publishes model usage. A long-running model call may show no token changes until it finishes. Requests that began before this observer started are not imported; previously recorded requests can resume after a reload.

Run **Antigravity Usage: Inspect Antigravity Integration** for the detected version, activation state, public API key names, connection state, and metadata availability. No token values or response bodies are logged. If activity connects but metadata is unavailable, timing still works and token queries retry automatically. Manual timers remain available.

The built-in adapter:

- Uses the already active extension's exported `port` and `csrfToken`, held only in memory. It does not activate/download Antigravity, scan processes, or read account credentials.
- Opens `JetboxSubscribeToSummaries` on `127.0.0.1` using Connect JSON framing, then reads `GetCascadeTrajectoryGeneratorMetadata` for observed conversations. Only these two read-only RPCs are used.
- Uses the summary map's **conversation ID**, not its distinct trajectory ID, for routing. New input times/step indices establish request boundaries. A missed completion remains interrupted rather than receiving an invented finish time.
- Sums each generation's reported `chatModel.usage.inputTokens` and `outputTokens` once within its turn. Repeated snapshots replace previous totals. Cache/reasoning breakdown fields are not added to these totals; this is the backend's token accounting, not a billing estimate. Missing/ambiguous fields remain unavailable or partial. Credit costs are not treated as USD.
- Continues querying for 30 seconds after completion to catch delayed usage, without extending the request duration. Later metadata can be missed until reconnection/reload.
- Displays the **active/latest reported request model**. Changing the idle model picker is not observable through this adapter. Per-model duration is the full duration of requests that involved that model.
- Observes top-level local conversations exposed by this backend, including conversations for other workspaces if the backend shares them. Cloud sessions and separate subagent token usage are excluded; a parent timer still waits for active children. Quota, reset times, and account history are unavailable.

See [protocol evidence and compatibility notes](docs/antigravity-protocol.md) for the inspected package and source references.

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

This public event contract is separate from the bundled local adapter; it is not an API claimed to exist in Google Antigravity. Do not feed the same requests through both paths.

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

Usage is stored in the extension host's global state and is shared across its workspaces/profile. In remote development this is on the remote host. It is not uploaded or registered for Settings Sync. Network requests are limited to the exported loopback backend. Backend messages can contain conversation titles, prompt/debug fields, or tool payloads; the adapter discards these immediately and stores only request IDs, timing, status, models, and token counts. The webview receives only that reduced data. Multiple independent VS Code windows do not currently coordinate writes; use one tracking window per profile.

The latest 1,000 finished requests and up to 100 active requests are retained. Overall token and request totals survive pruning. Date-filtered charts and per-model comparisons cover the retained details. Clearing history resets the details and overall totals.

After a restart or disconnect, unfinished automatic requests become **interrupted**. Newer backend activity can resume them; a stale saved RUNNING flag cannot. Known tokens are preserved, but a completion time is not invented. Clearing history establishes a new observation boundary to prevent old requests reappearing. Corrupt saved history is preserved until explicitly cleared.

Ideas for later: quota/reset indicators, usage alerts, cost estimates with configurable prices, and workspace/session breakdowns—each depending on available provider data.
