import { object } from './protocol';
import { Connection, connectionFrom, quotaSummary, transportDetail, userStatus } from './transport';
import type { Target } from './monitor';

export interface QuotaWindow {
  label: string;
  period?: 'weekly' | '5h';
  remainingFraction?: number;
  resetAt?: number;
  lowestReported?: boolean;
}
export interface QuotaEntry { label: string; scope: 'model' | 'group'; disabled?: boolean; windows: QuotaWindow[] }
export interface QuotaFamily { label: string; windows: QuotaWindow[]; unclassified?: QuotaWindow }
export interface QuotaSnapshot {
  state: 'waiting' | 'loading' | 'ready' | 'stale' | 'unavailable';
  entries: QuotaEntry[];
  updatedAt?: number;
  refreshing: boolean;
  detail?: string;
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || undefined : undefined;
}
function fraction(value: unknown): number | undefined {
  if (typeof value === 'string' && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}
function resetTime(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 8.64e15 ? parsed : undefined;
}

/** Keep only model/group labels, fractions and reset timestamps; discard user/account fields. */
export function parseModelQuotas(raw: unknown): QuotaEntry[] {
  const configs = object(object(object(raw).userStatus).cascadeModelConfigData).clientModelConfigs;
  if (!Array.isArray(configs)) return [];
  return configs.slice(0, 100).flatMap(rawModel => {
    const model = object(rawModel); const name = label(model.label);
    if (!name) return [];
    const quota = object(model.quotaInfo);
    return [{ label: name, scope: 'model' as const, disabled: model.disabled === true, windows: [{
      label: 'Model limit', remainingFraction: fraction(quota.remainingFraction), resetAt: resetTime(quota.resetTime),
    }] }];
  });
}

export function parseQuotaGroups(raw: unknown): QuotaEntry[] {
  const groups = object(object(raw).response).groups;
  if (!Array.isArray(groups)) return [];
  return groups.slice(0, 100).flatMap(rawGroup => {
    const group = object(rawGroup); const name = label(group.displayName);
    if (!name || !Array.isArray(group.buckets)) return [];
    const windows: QuotaWindow[] = group.buckets.slice(0, 10).map(rawBucket => {
      const bucket = object(rawBucket);
      const window = label(bucket.window);
      return {
        label: window === '5h' ? '5-hour limit' : window === 'weekly' ? 'Weekly limit' : label(bucket.displayName) ?? window ?? 'Shared limit',
        period: window === 'weekly' || window === '5h' ? window : undefined,
        remainingFraction: fraction(bucket.remainingFraction), resetAt: resetTime(bucket.resetTime),
      };
    });
    return windows.length ? [{ label: name, scope: 'group' as const, windows }] : [];
  });
}

/** Presentation only: effort/context variants share a row; percentages are never added. */
export function groupQuotaFamilies(entries: QuotaEntry[]): QuotaFamily[] {
  const families = ['Gemini Flash 3.8', 'Gemini Argon 4', 'Other models'];
  const familyIndex = (name: string): number => {
    if (/\bgemini\b/i.test(name)) {
      if (/\bflash\b/i.test(name) && /\b3\.8\b/.test(name)) return 0;
      if (/\bargon\b/i.test(name) && /\b4(?:\.0)?\b/.test(name)) return 1;
    }
    return 2;
  };
  const merge = (windows: QuotaWindow[], name: string, period?: QuotaWindow['period']): QuotaWindow => {
    const known = windows.filter(w => fraction(w.remainingFraction) !== undefined);
    // Choose a complete reading, so its reset timestamp belongs to the displayed fraction.
    const lowest = known.reduce<QuotaWindow | undefined>((result, w) =>
      !result || w.remainingFraction! < result.remainingFraction! ? w : result, undefined);
    return {
      label: name, period, remainingFraction: lowest?.remainingFraction,
      resetAt: lowest?.resetAt,
      lowestReported: new Set(known.map(w => w.remainingFraction)).size > 1,
    };
  };
  return families.map((name, index) => {
    const windows = entries.filter(entry => familyIndex(entry.label) === index).flatMap(entry => entry.windows);
    const periods = [merge(windows.filter(w => w.period === 'weekly'), 'Weekly', 'weekly'),
      merge(windows.filter(w => w.period === '5h'), '5 hours', '5h')];
    const unclassified = merge(windows.filter(w => !w.period), 'Period not reported');
    return {
      label: name, windows: periods,
      unclassified: periods.every(w => w.remainingFraction === undefined) && unclassified.remainingFraction !== undefined
        ? unclassified : undefined,
    };
  });
}

export async function fetchQuotas(connection: Connection, signal: AbortSignal): Promise<QuotaEntry[]> {
  const [models, groups] = await Promise.allSettled([userStatus(connection, signal), quotaSummary(connection, signal)]);
  if (models.status === 'rejected' && groups.status === 'rejected') throw models.reason;
  return [
    ...(models.status === 'fulfilled' ? parseModelQuotas(models.value) : []),
    ...(groups.status === 'fulfilled' ? parseQuotaGroups(groups.value) : []),
  ];
}

/** Independent polling keeps account limits available even when no request is running. */
export class QuotaMonitor {
  private connection?: Connection;
  private controller?: AbortController;
  private retryAt = 0;
  private lastAttempt = -Infinity;
  private disposed = false;
  private snapshot: QuotaSnapshot = { state: 'waiting', entries: [], refreshing: false };
  constructor(private options: {
    target(): Target | undefined;
    changed(snapshot: QuotaSnapshot): void;
    now?: () => number;
    fetch?: typeof fetchQuotas;
  }) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private publish(snapshot: QuotaSnapshot): void {
    if (JSON.stringify(snapshot) === JSON.stringify(this.snapshot)) return;
    this.snapshot = snapshot; this.options.changed(structuredClone(snapshot));
  }
  private cancel(): void { this.controller?.abort(); this.controller = undefined; }
  dispose(): void { this.disposed = true; this.cancel(); }
  async tick(force = false): Promise<void> {
    if (this.disposed) return;
    let connection: Connection | undefined;
    try {
      const target = this.options.target();
      connection = target?.isActive ? connectionFrom(target.exports) : undefined;
    } catch { /* The provider can replace its exports while restarting. */ }
    if (!connection) {
      this.cancel(); this.connection = undefined; this.retryAt = 0; this.lastAttempt = -Infinity;
      this.publish({ ...this.snapshot, state: this.snapshot.entries.length ? 'stale' : 'waiting', refreshing: false });
      return;
    }
    if (this.connection?.port !== connection.port || this.connection.csrfToken !== connection.csrfToken) {
      this.cancel(); this.connection = connection; this.retryAt = 0; this.lastAttempt = -Infinity;
      this.publish({ state: 'loading', entries: [], refreshing: false });
    }
    if (this.controller || this.now() - this.lastAttempt < 5000 || (!force && this.now() < this.retryAt)) return;
    this.lastAttempt = this.now(); this.retryAt = this.now() + 30000;
    const controller = this.controller = new AbortController();
    this.publish({ ...this.snapshot, refreshing: true });
    try {
      const entries = await (this.options.fetch ?? fetchQuotas)(connection, controller.signal);
      if (this.disposed || controller !== this.controller) return;
      this.publish({ state: entries.length ? 'ready' : 'unavailable', entries, updatedAt: this.now(), refreshing: false });
    } catch (error) {
      if (this.disposed || controller !== this.controller) return;
      this.publish({ ...this.snapshot, state: this.snapshot.entries.length ? 'stale' : 'unavailable', refreshing: false,
        detail: transportDetail(error) ?? 'Model limits unavailable.' });
    } finally { if (this.controller === controller) this.controller = undefined; }
  }
}
