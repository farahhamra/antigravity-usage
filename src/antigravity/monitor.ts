import { Tracker, RequestRecord } from '../tracker';
import { connectionFrom, Connection, Disposable, generatorMetadata, subscribe, transportDetail } from './transport';
import { object, summary, turnUsage } from './protocol';

export interface LiveStatus {
  state: 'missing' | 'waiting' | 'unsupported' | 'connecting' | 'connected' | 'retrying' | 'paused';
  usage: 'waiting' | 'available' | 'unavailable';
  detail?: string;
}
export interface Target { isActive: boolean; exports?: unknown }
interface Turn { id: string; conversationId: string; stepIndex: number; endStep?: number; pollAt: number; settleUntil: number }
interface Options {
  tracker: Tracker;
  target(): Target | undefined;
  changed(): void;
  status(value: LiveStatus): void;
  now?(): number;
  subscribe?: typeof subscribe;
  metadata?: typeof generatorMetadata;
}

/** Observes new top-level turns in this extension host; never activates the provider. */
export class AntigravityMonitor implements Disposable {
  private connection?: Connection;
  private stream?: Disposable;
  private abort = new AbortController();
  private generation = 0;
  private retryAt = 0;
  private busy = false;
  private disposed = false;
  private paused = false;
  private turns = new Map<string, Turn>();
  private since: number;
  private live: LiveStatus = { state: 'waiting', usage: 'waiting' };
  private now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.since = this.now();
  }
  private status(state: LiveStatus['state'], usage = this.live.usage, detail?: string): void {
    const next = { state, usage, detail };
    if (JSON.stringify(next) !== JSON.stringify(this.live)) { this.live = next; this.options.status(next); }
  }
  private disconnect(): void {
    this.generation++;
    this.stream?.dispose(); this.stream = undefined;
    this.abort.abort(); this.abort = new AbortController();
    this.connection = undefined;
    let changed = false;
    for (const record of this.options.tracker.list()) {
      if (record.antigravity && record.status === 'running') {
        changed = this.options.tracker.syncAntigravity({ ...record, status: 'interrupted' }) || changed;
      }
    }
    if (changed) this.options.changed();
  }
  reset(): void {
    this.disconnect(); this.turns.clear(); this.since = this.now(); this.retryAt = 0;
  }
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) { this.disconnect(); this.status('paused'); }
  }
  dispose(): void { this.disposed = true; this.disconnect(); }

  private receive(raw: unknown): void {
    const now = this.now();
    const message = object(raw);
    this.status('connected', this.live.usage, this.live.detail);
    let changed = false;
    for (const [conversationId, value] of Object.entries(object(message.updates)).slice(0, 10000)) {
      const parsed = summary(conversationId, value, now);
      if (!parsed) continue;
      const current = this.options.tracker.get(parsed.id);
      if (!current && parsed.startedAt < this.since) continue; // Do not import old account history or replay pruned rows.
      if (current && parsed.updatedAt < current.updatedAt) continue;
      if (current?.status === 'interrupted' && current.endedAt !== undefined && parsed.status === 'running') continue;
      if (current?.endedAt !== undefined && parsed.status === 'running' && parsed.updatedAt <= current.updatedAt) continue;
      // On reconnect, a persisted RUNNING flag alone is not proof an old execution is alive.
      if (current?.status === 'interrupted' && parsed.status === 'running' && parsed.updatedAt <= current.updatedAt) continue;
      // A later user input supplies the upper step bound for the preceding turn.
      for (const old of this.options.tracker.list()) {
        if (old.antigravity?.conversationId !== conversationId || old.antigravity.stepIndex >= parsed.stepIndex
          || old.startedAt > parsed.startedAt) continue;
        let turn = this.turns.get(old.id);
        // Only close a turn known to be running. Older interrupted history has no reliable stop time.
        if (old.status === 'running') {
          changed = this.options.tracker.syncAntigravity({ ...old, status: 'interrupted',
            endedAt: parsed.startedAt, updatedAt: Math.max(old.updatedAt, parsed.startedAt) }) || changed;
          if (!turn) {
            turn = { id: old.id, conversationId, stepIndex: old.antigravity.stepIndex, pollAt: 0, settleUntil: now + 30000 };
            this.turns.set(old.id, turn);
          }
          turn.settleUntil = now + 30000;
        }
        if (turn) turn.endStep = Math.min(turn.endStep ?? Infinity, parsed.stepIndex);
      }
      const record: RequestRecord = {
        ...current, id: parsed.id, model: current?.model ?? 'Awaiting model', source: 'integration',
        startedAt: parsed.startedAt, updatedAt: parsed.updatedAt, status: parsed.status,
        endedAt: parsed.endedAt, antigravity: { conversationId, stepIndex: parsed.stepIndex },
        usagePartial: current?.usagePartial ?? true,
      };
      // A completed turn's duration stays fixed while final metadata arrives.
      if (current?.endedAt !== undefined && parsed.status !== 'running') {
        record.endedAt = current.endedAt; record.updatedAt = current.updatedAt;
        if (current.status === 'interrupted') record.status = 'interrupted';
      }
      changed = this.options.tracker.syncAntigravity(record) || changed;
      if (!this.options.tracker.get(parsed.id)) continue;
      const previous = this.turns.get(parsed.id);
      this.turns.set(parsed.id, {
        id: parsed.id, conversationId, stepIndex: parsed.stepIndex, endStep: previous?.endStep,
        pollAt: previous?.pollAt ?? 0,
        settleUntil: parsed.status === 'running' ? Infinity : previous?.settleUntil === Infinity || !previous ? now + 30000 : previous.settleUntil,
      });
    }
    if (Array.isArray(message.deletes)) {
      for (const turn of this.turns.values()) {
        if (!message.deletes.includes(turn.conversationId)) continue;
        const record = this.options.tracker.get(turn.id);
        if (record?.status === 'running') changed = this.options.tracker.syncAntigravity({ ...record, status: 'interrupted' }) || changed;
        this.turns.delete(turn.id);
      }
    }
    for (const [id, turn] of this.turns) {
      if (turn.settleUntil < now || !this.options.tracker.get(id)) this.turns.delete(id);
    }
    if (changed) this.options.changed();
  }

  async tick(): Promise<void> {
    if (this.disposed || this.paused || this.busy) return;
    this.busy = true;
    try {
      const target = this.options.target();
      const connection = target?.isActive ? connectionFrom(target.exports) : undefined;
      if (!connection) {
        if (this.connection) this.disconnect();
        this.status(!target ? 'missing' : !target.isActive ? 'waiting' : 'unsupported', 'waiting');
        return;
      }
      if (this.connection && (this.connection.port !== connection.port || this.connection.csrfToken !== connection.csrfToken)) {
        this.disconnect(); this.retryAt = 0;
      }
      if (!this.stream) {
        if (this.now() < this.retryAt) return;
        this.connection = connection;
        this.status('connecting', 'waiting');
        const generation = ++this.generation;
        this.stream = (this.options.subscribe ?? subscribe)(connection, message => {
          if (this.disposed || this.generation !== generation) return;
          this.receive(message);
        }, detail => {
          if (this.disposed || this.generation !== generation) return;
          this.disconnect(); this.retryAt = this.now() + 5000; this.status('retrying', 'waiting', detail);
        });
      }
      if (this.live.state !== 'connected') return;
      const generation = this.generation;
      const due = [...this.turns.values()].filter(t => t.pollAt <= this.now() && t.settleUntil >= this.now());
      // At most four conversations per tick; one RPC serves all their observed turns.
      const conversations = [...new Set(due.sort((a, b) => a.pollAt - b.pollAt).map(t => t.conversationId))].slice(0, 4);
      for (const conversationId of conversations) {
        if (this.disposed || this.generation !== generation) return;
        const turns = [...this.turns.values()].filter(t => t.conversationId === conversationId && t.settleUntil >= this.now());
        for (const turn of turns) turn.pollAt = this.now() + 3000;
        try {
          const raw = await (this.options.metadata ?? generatorMetadata)(connection, conversationId, this.abort.signal);
          if (this.disposed || this.generation !== generation) return;
          let changed = false;
          for (const turn of turns) {
            const record = this.options.tracker.get(turn.id);
            if (!record) continue;
            const usage = turnUsage(raw, turn.stepIndex, turn.endStep);
            changed = this.options.tracker.syncAntigravity({ ...record, ...usage, model: usage.model ?? record.model }) || changed;
          }
          this.status('connected', 'available');
          if (changed) this.options.changed();
        } catch (error) {
          if (this.generation !== generation) return;
          this.status('connected', 'unavailable', transportDetail(error) ?? 'Usage metadata format is unavailable.');
        }
      }
    } catch {
      this.disconnect(); this.retryAt = this.now() + 5000; this.status('retrying', 'unavailable');
    } finally { this.busy = false; }
  }
}
