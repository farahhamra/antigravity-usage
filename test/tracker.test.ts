import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, parseEvent } from '../src/tracker';

const start = (tracker: Tracker, id = 'turn-1', at = 1000, model = 'Model A') =>
  tracker.apply({ type: 'start', requestId: id, at, model }, 'integration');

test('tracks an entire request with cumulative streaming usage and final totals', () => {
  const tracker = new Tracker();
  start(tracker);
  tracker.apply({ type: 'usage', requestId: 'turn-1', at: 2000, inputTokens: 120, outputTokens: 5 }, 'integration');
  tracker.apply({ type: 'usage', requestId: 'turn-1', at: 4000, inputTokens: 120, outputTokens: 40 }, 'integration');
  tracker.apply({ type: 'finish', requestId: 'turn-1', at: 9000, status: 'completed', outputTokens: 60, costUsd: 0.003 }, 'integration');
  const record = tracker.list()[0]!;
  assert.equal(record.endedAt! - record.startedAt, 8000);
  assert.equal(record.inputTokens, 120);
  assert.equal(record.outputTokens, 60);
  assert.equal(record.costUsd, 0.003);
  assert.equal(record.status, 'completed');
  assert.deepEqual(tracker.totals().inputTokens, { value: 120, known: 1 });
});

test('distinguishes unavailable usage from a reported zero', () => {
  const tracker = new Tracker();
  start(tracker);
  assert.equal(tracker.list()[0]?.inputTokens, undefined);
  tracker.apply({ type: 'usage', requestId: 'turn-1', at: 2000, inputTokens: 0 }, 'integration');
  assert.deepEqual(tracker.totals().inputTokens, { value: 0, known: 1 });
  assert.deepEqual(tracker.totals().outputTokens, { value: 0, known: 0 });
});

test('keeps simultaneous requests attributed to their original models', () => {
  const tracker = new Tracker();
  start(tracker, 'a', 1000, 'Model A');
  start(tracker, 'b', 2000, 'Model B');
  tracker.apply({ type: 'model', model: 'Model C' }, 'integration');
  tracker.apply({ type: 'finish', requestId: 'a', at: 4000, status: 'completed', inputTokens: 30 }, 'integration');
  assert.equal(tracker.list().find(r => r.id === 'a')?.model, 'Model A');
  assert.equal(tracker.selectedModel, 'Model C');
  assert.equal(tracker.list().find(r => r.status === 'running')?.startedAt, 2000);
});

test('repeated start and terminal events do not double-count', () => {
  const tracker = new Tracker();
  start(tracker); start(tracker);
  const finish = { type: 'finish', requestId: 'turn-1', at: 4000, status: 'completed', inputTokens: 100 };
  tracker.apply(finish, 'integration'); tracker.apply(finish, 'integration');
  assert.equal(tracker.totals().requests, 1);
  assert.equal(tracker.totals().inputTokens.value, 100);
});

test('invalid, stale, or decreasing events leave request state intact', () => {
  const tracker = new Tracker();
  start(tracker);
  tracker.apply({ type: 'usage', requestId: 'turn-1', at: 3000, inputTokens: 100, outputTokens: 20 }, 'integration');
  const before = tracker.serialize();
  for (const event of [
    { type: 'usage', requestId: 'turn-1', at: 2000, outputTokens: 30 },
    { type: 'usage', requestId: 'turn-1', at: 4000, inputTokens: 120, outputTokens: 10 },
    { type: 'usage', requestId: 'turn-1', at: 4000, inputTokens: -1 },
    { type: 'finish', requestId: 'missing', at: 4000, status: 'completed' },
    { type: 'start', requestId: 'turn-1', at: 4000, model: 'different' },
  ]) assert.throws(() => tracker.apply(event, 'integration'));
  assert.deepEqual(tracker.serialize(), before);
});

test('prevents source mixing and updates after completion', () => {
  const tracker = new Tracker();
  start(tracker);
  assert.throws(() => tracker.apply({ type: 'usage', requestId: 'turn-1', at: 3000, inputTokens: 2 }, 'manual'));
  tracker.apply({ type: 'finish', requestId: 'turn-1', at: 4000, status: 'completed' }, 'integration');
  assert.throws(() => tracker.apply({ type: 'usage', requestId: 'turn-1', at: 5000, inputTokens: 4 }, 'integration'));
});

test('rejects malformed public API events', () => {
  for (const event of [
    null, [], {}, { type: 'model', model: '' },
    { type: 'start', requestId: 'x', model: 'x', at: '2026-01-01' },
    { type: 'usage', requestId: 'x', at: 2, inputTokens: 0.1 },
    { type: 'usage', requestId: 'x', at: 2, outputTokens: Infinity },
    { type: 'usage', requestId: 'x', at: 2, costUsd: NaN },
    { type: 'finish', requestId: 'x', at: 2, status: 'unknown' },
  ]) assert.throws(() => parseEvent(event));
});

test('reload preserves totals and marks unfinished requests interrupted without inventing a duration', () => {
  const original = new Tracker();
  start(original);
  original.apply({ type: 'usage', requestId: 'turn-1', at: 2000, inputTokens: 42 }, 'integration');
  const restored = new Tracker(); restored.restore(original.serialize());
  assert.equal(restored.list()[0]?.status, 'interrupted');
  assert.equal(restored.list()[0]?.endedAt, undefined);
  assert.equal(restored.list().filter(r => r.status === 'running').length, 0);
  assert.equal(restored.totals().inputTokens.value, 42);
});

test('failed and cancelled requests preserve consumed tokens and outcome status', () => {
  const tracker = new Tracker();
  for (const [i, status] of ['failed', 'cancelled', 'completed'].entries()) {
    start(tracker, String(i), 1000);
    tracker.apply({ type: 'finish', requestId: String(i), at: 2000 + i * 1000, status, inputTokens: 10 }, 'integration');
  }
  for (const status of ['failed', 'cancelled', 'completed']) assert.equal(tracker.list().filter(r => r.status === status).length, 1);
  assert.equal(tracker.totals().inputTokens.value, 30);
});

test('overall totals survive detailed-history retention, reload, and then clear', () => {
  const tracker = new Tracker();
  start(tracker, 'still-running', 0);
  for (let i = 1; i <= Tracker.limit + 5; i++) {
    start(tracker, String(i), i * 10);
    tracker.apply({ type: 'finish', requestId: String(i), at: i * 10 + 1, status: 'completed', inputTokens: 2, outputTokens: 3 }, 'integration');
  }
  assert.equal(tracker.list().length, Tracker.limit + 1);
  assert.equal(tracker.totals().requests, Tracker.limit + 6);
  assert.equal(tracker.totals().inputTokens.value, (Tracker.limit + 5) * 2);
  assert.ok(tracker.list().some(r => r.id === 'still-running'));
  const restored = new Tracker(); restored.restore(tracker.serialize());
  assert.deepEqual(restored.totals(), tracker.totals());
  restored.clear();
  assert.equal(restored.totals().requests, 0);
  assert.equal(restored.list().length, 0);
});

test('rejects corrupted saved state atomically', () => {
  const tracker = new Tracker(); start(tracker);
  const before = tracker.serialize();
  assert.throws(() => tracker.restore({ version: 1, records: [{ id: 'bad' }] }));
  assert.throws(() => tracker.restore({ version: 1, records: [], archived: { requests: -1 } }));
  assert.deepEqual(tracker.serialize(), before);
});

test('returns snapshots independent of mutable internal records', () => {
  const tracker = new Tracker(); start(tracker);
  tracker.list()[0]!.model = 'changed';
  tracker.totals().inputTokens.value = 999;
  assert.equal(tracker.list()[0]?.model, 'Model A');
  assert.equal(tracker.totals().inputTokens.value, 0);
});
