export type RequestStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type Source = 'manual' | 'integration';
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}
export interface RequestRecord extends Usage {
  id: string;
  model: string;
  source: Source;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status: RequestStatus;
  antigravity?: { conversationId: string; stepIndex: number };
  modelUsage?: (Usage & { model: string })[];
  usagePartial?: boolean;
}
export interface Totals {
  requests: number;
  partialRequests: number;
  inputTokens: { value: number; known: number };
  outputTokens: { value: number; known: number };
  costUsd: { value: number; known: number };
}
const emptyTotals = (): Totals => ({
  requests: 0, partialRequests: 0, inputTokens: { value: 0, known: 0 }, outputTokens: { value: 0, known: 0 }, costUsd: { value: 0, known: 0 },
});
function addRecord(totals: Totals, record: RequestRecord): void {
  totals.requests++;
  if (record.usagePartial) totals.partialRequests++;
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    if (record[key] !== undefined) {
      totals[key].value += record[key];
      totals[key].known++;
    }
  }
}
export type TrackingEvent =
  | { type: 'model'; model: string }
  | { type: 'start'; requestId: string; model: string; at: number }
  | ({ type: 'usage'; requestId: string; at: number } & Usage)
  | ({ type: 'finish'; requestId: string; at: number; status: 'completed' | 'failed' | 'cancelled' } & Usage);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an event object.');
  return value as Record<string, unknown>;
}
function label(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error(`Invalid ${name}.`);
  return value.trim();
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8.64e15) {
    throw new Error('at must be a Unix timestamp in milliseconds.');
  }
  return value;
}
function usage(value: Record<string, unknown>): Usage {
  const result: Usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0
      || (key !== 'costUsd' && !Number.isSafeInteger(n))) throw new Error(`Invalid ${key}.`);
    result[key] = n;
  }
  return result;
}
export function parseEvent(value: unknown): TrackingEvent {
  const event = object(value);
  if (event.type === 'model') return { type: 'model', model: label(event.model, 'model') };
  const requestId = label(event.requestId, 'requestId');
  const at = timestamp(event.at);
  if (event.type === 'start') return { type: 'start', requestId, at, model: label(event.model, 'model') };
  if (event.type === 'usage') return { type: 'usage', requestId, at, ...usage(event) };
  if (event.type === 'finish' && ['completed', 'failed', 'cancelled'].includes(String(event.status))) {
    return { type: 'finish', requestId, at, status: event.status as 'completed' | 'failed' | 'cancelled', ...usage(event) };
  }
  throw new Error('Unsupported tracking event.');
}

/** One start/finish pair represents a whole agent turn, including tool calls. */
export class Tracker {
  private records = new Map<string, RequestRecord>();
  private archived = emptyTotals();
  private archivedAntigravityThrough = 0;
  selectedModel?: string;
  selectionSource: Source = 'manual';
  static readonly limit = 1000;

  apply(raw: unknown, source: Source): void {
    const event = parseEvent(raw);
    if (event.type === 'model') {
      this.selectedModel = event.model;
      this.selectionSource = source;
      return;
    }
    const current = this.records.get(event.requestId);
    if (event.type === 'start') {
      if (current) {
        if (current.model === event.model && current.startedAt === event.at && current.source === source) return;
        throw new Error('Request ID already exists.');
      }
      if (this.list().filter(r => r.status === 'running').length >= 100) throw new Error('Too many active requests.');
      this.records.set(event.requestId, {
        id: event.requestId, model: event.model, source, startedAt: event.at, updatedAt: event.at, status: 'running',
      });
      this.selectedModel = event.model;
      this.selectionSource = source;
      this.prune();
      return;
    }
    if (!current) throw new Error('Request has no start event.');
    if (current.source !== source) throw new Error('Request source does not match.');
    if (event.at < current.updatedAt) throw new Error('Event timestamp is out of order.');
    if (current.status !== 'running') {
      // Retries of an identical terminal event are safe.
      if (event.type === 'finish' && current.status === event.status && current.endedAt === event.at
        && (['inputTokens', 'outputTokens', 'costUsd'] as const).every(k => event[k] === undefined || event[k] === current[k])) return;
      throw new Error('Request has already ended.');
    }
    const next = { ...current, updatedAt: event.at };
    for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
      const value = event[key];
      if (value === undefined) continue;
      if (value < (current[key] ?? 0)) throw new Error('Usage updates must be cumulative and cannot decrease.');
      next[key] = value;
    }
    if (event.type === 'finish') {
      next.endedAt = event.at;
      next.status = event.status;
    }
    this.records.set(next.id, next);
    this.prune();
  }

  list(): RequestRecord[] {
    return Array.from(this.records.values(), r => structuredClone(r)).sort((a, b) => b.startedAt - a.startedAt);
  }
  get(id: string): RequestRecord | undefined {
    const record = this.records.get(id);
    return record && structuredClone(record);
  }
  /** The built-in adapter replaces snapshots, including late final usage and resumed requests. */
  syncAntigravity(record: RequestRecord): boolean {
    if (!record.antigravity || record.source !== 'integration' || !record.id.startsWith('antigravity:')) throw new Error('Invalid Antigravity record.');
    const current = this.records.get(record.id);
    if (!current && record.startedAt <= this.archivedAntigravityThrough) return false;
    if (current && (!current.antigravity || current.source !== record.source || current.startedAt !== record.startedAt)) throw new Error('Request ID already exists.');
    if (current && record.updatedAt < current.updatedAt) return false;
    const next = structuredClone(record);
    // A delayed/partial backend snapshot must not erase already reported counts.
    const keys = ['inputTokens', 'outputTokens', 'costUsd'] as const;
    if (current && keys.some(key => current[key] !== undefined && (next[key] === undefined || next[key]! < current[key]!))) {
      for (const key of keys) {
        if (current[key] === undefined) delete next[key];
        else next[key] = current[key];
      }
      next.usagePartial = true;
      next.modelUsage = current.modelUsage;
    }
    if (JSON.stringify(current) === JSON.stringify(next)) return false;
    if (!current && next.status === 'running' && this.list().filter(r => r.status === 'running').length >= 100) return false;
    this.records.set(next.id, next);
    if (next.model !== 'Awaiting model' && (!this.selectedModel || next.startedAt >= Math.max(0, ...this.list().filter(r => r.id !== next.id).map(r => r.startedAt)))) {
      this.selectedModel = next.model; this.selectionSource = 'integration';
    }
    this.prune();
    return true;
  }
  clear(): void { this.records.clear(); this.archived = emptyTotals(); this.archivedAntigravityThrough = 0; }
  totals(): Totals {
    const totals = structuredClone(this.archived);
    for (const record of this.records.values()) addRecord(totals, record);
    return totals;
  }
  serialize(): unknown {
    return { version: 1, selectedModel: this.selectedModel, selectionSource: this.selectionSource, archived: structuredClone(this.archived), archivedAntigravityThrough: this.archivedAntigravityThrough, records: this.list() };
  }
  restore(raw: unknown): void {
    const data = object(raw);
    if (data.version !== 1 || !Array.isArray(data.records) || data.records.length > Tracker.limit + 100) {
      throw new Error('Unsupported or invalid saved usage history.');
    }
    const restored = new Map<string, RequestRecord>();
    for (const item of data.records) {
      const r = object(item);
      const startedAt = timestamp(r.startedAt);
      const updatedAt = timestamp(r.updatedAt);
      const endedAt = r.endedAt === undefined ? undefined : timestamp(r.endedAt);
      if (!['manual', 'integration'].includes(String(r.source))
        || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(r.status))
        || updatedAt < startedAt || (endedAt !== undefined && (endedAt < startedAt || endedAt !== updatedAt))
        || (['completed', 'failed', 'cancelled'].includes(String(r.status)) && endedAt === undefined)
        || (['running', 'interrupted'].includes(String(r.status)) && endedAt !== undefined)) {
        throw new Error('Invalid saved request.');
      }
      const record: RequestRecord = {
        id: label(r.id, 'id'), model: label(r.model, 'model'), source: r.source as Source,
        startedAt, updatedAt, endedAt, status: r.status === 'running' ? 'interrupted' : r.status as RequestStatus, ...usage(r),
      };
      if (r.antigravity !== undefined) {
        const a = object(r.antigravity);
        if (r.source !== 'integration' || !record.id.startsWith('antigravity:')
          || typeof a.conversationId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(a.conversationId)
          || !Number.isSafeInteger(a.stepIndex) || (a.stepIndex as number) < 0) throw new Error('Invalid saved Antigravity request.');
        record.antigravity = { conversationId: a.conversationId, stepIndex: a.stepIndex as number };
        if (r.usagePartial !== undefined && typeof r.usagePartial !== 'boolean') throw new Error('Invalid usage coverage.');
        record.usagePartial = r.usagePartial as boolean | undefined;
        if (r.modelUsage !== undefined) {
          if (!Array.isArray(r.modelUsage) || r.modelUsage.length > 100) throw new Error('Invalid model usage.');
          record.modelUsage = r.modelUsage.map(item => { const m = object(item); return { model: label(m.model, 'model'), ...usage(m) }; });
        }
      }
      if (restored.has(record.id)) throw new Error('Duplicate saved request ID.');
      restored.set(record.id, record);
    }
    const selectedModel = data.selectedModel === undefined ? undefined : label(data.selectedModel, 'model');
    const archived = emptyTotals();
    if (data.archived !== undefined) {
      const a = object(data.archived);
      if (!Number.isSafeInteger(a.requests) || (a.requests as number) < 0) throw new Error('Invalid archived totals.');
      archived.requests = a.requests as number;
      const partial = a.partialRequests ?? 0;
      if (!Number.isSafeInteger(partial) || (partial as number) < 0 || (partial as number) > archived.requests) throw new Error('Invalid partial usage count.');
      archived.partialRequests = partial as number;
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
        const stat = object(a[key]);
        if (!Number.isSafeInteger(stat.known) || (stat.known as number) < 0 || (stat.known as number) > archived.requests
          || typeof stat.value !== 'number' || !Number.isFinite(stat.value) || stat.value < 0
          || (key !== 'costUsd' && !Number.isSafeInteger(stat.value))
          || (stat.known === 0 && stat.value !== 0)) throw new Error('Invalid archived usage.');
        archived[key] = { value: stat.value, known: stat.known as number };
      }
    }
    const archivedAntigravityThrough = data.archivedAntigravityThrough === undefined ? 0 : timestamp(data.archivedAntigravityThrough);
    this.records = restored;
    this.archived = archived;
    this.archivedAntigravityThrough = archivedAntigravityThrough;
    this.selectedModel = selectedModel;
    this.selectionSource = data.selectionSource === 'integration' ? 'integration' : 'manual';
    this.prune();
  }
  private prune(): void {
    const completed = this.list().filter(r => r.status !== 'running');
    for (const record of completed.slice(Tracker.limit)) {
      addRecord(this.archived, record);
      if (record.antigravity) this.archivedAntigravityThrough = Math.max(this.archivedAntigravityThrough, record.startedAt);
      this.records.delete(record.id);
    }
  }
}
