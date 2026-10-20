import type { RequestStatus, Usage } from '../tracker';

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function count(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function time(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) || undefined;
}
export interface Summary {
  id: string;
  conversationId: string;
  stepIndex: number;
  startedAt: number;
  updatedAt: number;
  status: RequestStatus;
  endedAt?: number;
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Reduce immediately: retain no titles, prompts, tool payloads, workspace paths, or credentials. */
export function summary(conversationId: string, raw: unknown, now: number): Summary | undefined {
  const value = object(raw);
  const metadata = object(value.trajectoryMetadata);
  if (!UUID.test(conversationId) || value.cloud === true || metadata.parentConversationId
    || (count(metadata.nestingDepth) ?? 0) > 0) return;
  const startedAt = time(value.lastUserInputTime);
  const updatedAt = time(value.lastModifiedTime);
  const stepIndex = count(value.lastUserInputStepIndex ?? 0);
  if (startedAt === undefined || updatedAt === undefined || stepIndex === undefined
    || updatedAt < startedAt || updatedAt > now + 5000 || stepIndex > 0xffffffff) return;
  const run = value.status;
  const active = [2, 3, 4, 'CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_CANCELING', 'CASCADE_RUN_STATUS_BUSY'].includes(run as string | number)
    || value.notFullyIdle === true || value.hasActiveChildren === true;
  const reason = value.latestExecutorTerminationReason;
  let status: RequestStatus;
  if (value.interrupted === true || value.killed === true) status = 'interrupted';
  else if (active) status = 'running';
  else if (run === 1 || run === 'CASCADE_RUN_STATUS_IDLE') {
    status = reason === 2 || reason === 'EXECUTOR_TERMINATION_REASON_USER_CANCELED' ? 'cancelled'
      : [1, 3, 6, 11, 'EXECUTOR_TERMINATION_REASON_ERROR', 'EXECUTOR_TERMINATION_REASON_MAX_INVOCATIONS',
        'EXECUTOR_TERMINATION_REASON_MAX_FORCED_INVOCATIONS', 'EXECUTOR_TERMINATION_REASON_MAX_TOKEN_BUDGET_EXCEEDED'].includes(reason as string | number) ? 'failed' : 'completed';
  } else return;
  return {
    id: `antigravity:${conversationId}:${startedAt}:${stepIndex}`, conversationId, stepIndex, startedAt, updatedAt, status,
    ...(['completed', 'cancelled', 'failed'].includes(status) ? { endedAt: updatedAt } : {}),
  };
}

export interface ModelUsage extends Usage { model: string }
export interface TurnUsage extends Usage { model?: string; modelUsage: ModelUsage[]; usagePartial: boolean }

/** Generator records are cumulative snapshots, not increments. Step indices identify the user turn. */
export function turnUsage(raw: unknown, startStep: number, endStep = Infinity): TurnUsage {
  const entries = object(raw).generatorMetadata;
  if (!Array.isArray(entries) || entries.length > 10000) throw new Error('Unsupported Antigravity metadata response.');
  const groups = new Map<string, ModelUsage>();
  let partial = false;
  let latestModel: string | undefined;
  let latestStep = -1;
  const result: TurnUsage = { modelUsage: [], usagePartial: false };
  for (const entry of entries) {
    const generator = object(entry);
    if (Array.isArray(generator.stepIndices) && generator.stepIndices.length > 10000) throw new Error('Antigravity step limit exceeded.');
    const indices = Array.isArray(generator.stepIndices) ? generator.stepIndices.map(count) : [];
    if (!indices.length || indices.some(i => i === undefined)) { partial = true; continue; }
    const first = Math.min(...indices as number[]);
    const last = Math.max(...indices as number[]);
    if (last < startStep || first >= endStep) continue;
    // A generation spanning two user turns cannot be safely divided.
    if (first < startStep || last >= endStep) { partial = true; continue; }
    const chat = object(generator.chatModel);
    const model = label(chat.modelDisplayName) ?? label(chat.responseModel) ?? 'Unreported model';
    if (last >= latestStep) { latestStep = last; latestModel = model; }
    const usage = object(chat.usage);
    const group = groups.get(model) ?? { model };
    for (const key of ['inputTokens', 'outputTokens'] as const) {
      // Preserve the provider's total fields. Cache/reasoning breakdowns are not added again.
      const n = count(usage[key]);
      if (n === undefined) { partial = true; continue; }
      const total = (result[key] ?? 0) + n;
      const modelTotal = (group[key] ?? 0) + n;
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(modelTotal)) throw new Error('Antigravity token count exceeds the supported range.');
      result[key] = total; group[key] = modelTotal;
    }
    groups.set(model, group);
    if (groups.size > 100) throw new Error('Antigravity model limit exceeded.');
  }
  result.model = latestModel;
  result.modelUsage = [...groups.values()];
  result.usagePartial = partial || !groups.size;
  return result;
}
