# Antigravity adapter evidence

The adapter is experimental. The official package establishes the exported connection and message schemas; open-source integrations identify the local RPC names. Automated fixtures exercise this interpretation. This is not a claim of a stable public Google API or a successful signed-in provider test.

## Inspected official package

- Marketplace: <https://marketplace.visualstudio.com/items?itemName=Google.google-antigravity>
- Version: **1.8.0**, inspected October 2026.
- Download: <https://marketplace.visualstudio.com/_apis/public/gallery/publishers/Google/vsextensions/google-antigravity/1.8.0/vspackage>
- Decoded VSIX SHA-256, matched against Marketplace metadata: `876193bce904497f7a09efe36b7faf6d5f2a1fe580ff854b863d34251e0438e6`.
- Activation exports a CSRF token and a port getter from the local hub manager. Package code was inspected, not executed.
- Embedded protobuf descriptors define `CascadeTrajectorySummary`, `CortexStepGeneratorMetadata`, `ChatModelMetadata`, and `ModelUsageStats`.

Relevant protobuf JSON fields:

| Message | Fields used |
| --- | --- |
| Summary stream | `updates` map keyed by conversation ID; `deletes` |
| `CascadeTrajectorySummary` | `lastUserInputTime`, `lastUserInputStepIndex`, `lastModifiedTime`, `status`, `notFullyIdle`, `hasActiveChildren`, `killed`, `interrupted`, `latestExecutorTerminationReason`, `cloud`, `trajectoryMetadata` |
| Generator metadata response | `generatorMetadata` array |
| `CortexStepGeneratorMetadata` | `stepIndices`, `chatModel` |
| `ChatModelMetadata` | `modelDisplayName`, `responseModel`, `usage` |
| `ModelUsageStats` | `inputTokens`, `outputTokens` (protobuf uint64, often JSON strings) |
| `GetUserStatus` response | `userStatus.cascadeModelConfigData.clientModelConfigs`: `label`, `disabled`, `quotaInfo.remainingFraction`, `quotaInfo.resetTime` |
| `RetrieveUserQuotaSummary` response | `response.groups`: `displayName`, `buckets[].remainingFraction`, `buckets[].window`, `buckets[].displayName`, `buckets[].resetTime` |

The selected model in an idle model picker is not present in these observations. `modelCost` and credit fields have no established USD meaning here. Separate cache and reasoning fields are not blindly summed into input/output totals.

## Independent protocol references

- [agent-pet's Antigravity activity adapter](https://github.com/merttalhayener/agent-pet/blob/main/src/antigravity-activity.cjs): Google extension discovery, exported connection, `JetboxSubscribeToSummaries`, Connect framing, conversation routing IDs, and stale lifecycle handling.
- [antigravity-token-monitor](https://github.com/ddarkr/antigravity-token-monitor): `GetCascadeTrajectoryGeneratorMetadata` and its `generatorMetadata` response field.
- [ag-usage](https://github.com/crsxmilitaru/ag-usage/blob/main/src/api.ts): `RetrieveUserQuotaSummary` and `GetUserStatus` quota responses. `ClientModelConfig` and `QuotaInfo` are also present in the official package's protobuf descriptors. Shared-group response fields are based on this independent reference.

The implementation here is original and limited to those four read-only endpoints. It does not use third-party process scanning, transcript retrieval, message-flushing methods, TLS bypasses, or heuristic recursive token extraction. The display consolidates labels into Gemini Flash 3.8, Gemini Argon 4, and Other models, ignoring effort/context suffixes and accepting reversed model/version order. This is presentation grouping, not an inferred provider pool ID. Weekly/5-hour slots only use explicit provider bucket periods. Unclassified model limits remain labelled “period not reported” when neither period is available. Duplicate percentages are not added; differing readings use the lowest remaining fraction with its own reset timestamp and an explicit label. Quota fractions must fall within [0, 1]; missing or invalid values remain unknown.

## Validation and compatibility

Tests use synthetic protobuf JSON, fragmented Connect envelopes, and actual loopback HTTP fixtures to verify authentication, request bodies, bounded framing, token attribution, saved interruption timing, quota parsing/polling, stale readings, delayed updates, safe failure, and cancellation. The full Electron extension host and an authenticated Antigravity backend remain untested in cloud.

If Google changes the exports or endpoints, the dashboard reports unavailable/retrying status. Timing can continue if summaries work while token metadata does not. No estimated token numbers are substituted. Install the VSIX alongside Google Antigravity and send a new request to validate provider compatibility on the target machine.
