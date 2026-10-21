import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import { Tracker } from '../src/tracker';
import { AntigravityMonitor, LiveStatus, Target } from '../src/antigravity/monitor';
import { connectionFrom, Frames, generatorMetadata, subscribe } from '../src/antigravity/transport';
import { count, summary, turnUsage } from '../src/antigravity/protocol';

const id = '12345678-1234-1234-1234-123456789abc';
const secondId = '12345678-1234-1234-1234-123456789def';
const iso = (n: number) => new Date(n).toISOString();
function summaryData(start = 1000, updated = 2000, step = 0, status: string | number = 'CASCADE_RUN_STATUS_RUNNING') {
  return { lastUserInputTime: iso(start), lastModifiedTime: iso(updated), lastUserInputStepIndex: step, status,
    trajectoryId: secondId, summary: 'Private conversation title that must not be stored' };
}
function generation(steps: number[], input: unknown = '100', output: unknown = '20', model = 'Gemini') {
  return { stepIndices: steps, executionId: 'model-call', chatModel: {
    modelDisplayName: model, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: '80', thinkingOutputTokens: '15', responseOutputTokens: '5' },
    systemPrompt: 'Private prompt that must not be stored', modelCost: 9,
  } };
}
const envelope = (value: unknown, flags = 0) => {
  const json = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(5);
  header[0] = flags; header.writeUInt32BE(json.length, 1); return Buffer.concat([header, json]);
};
function fixture() {
  const tracker = new Tracker(); let now = 500; let receives: (raw: unknown) => void = () => {};
  let closes: () => void = () => {}; let polls = 0; let connections = 0;
  let metadata: unknown = { generatorMetadata: [] };
  let live: LiveStatus | undefined;
  let target: Target | undefined = { isActive: true, exports: { port: 12345, csrfToken: 'synthetic-test-token' } };
  const monitor = new AntigravityMonitor({
    tracker, now: () => now, target: () => target, changed() {}, status: value => { live = value; },
    subscribe: (_connection, onMessage, onClose) => { connections++; receives = onMessage; closes = onClose; return { dispose() {} }; },
    metadata: async (_connection, conversation) => { polls++; assert.equal(conversation, id); return metadata; },
  });
  return {
    tracker, monitor, send: (value: unknown = summaryData()) => receives({ updates: { [id]: value } }),
    raw: (value: unknown) => receives(value), close: () => closes(),
    time: (value: number) => { now = value; }, metadata: (value: unknown) => { metadata = value; },
    target: (value?: Target) => { target = value; }, live: () => live, polls: () => polls, connections: () => connections,
  };
}

test('uses only a validated local connection; rejects malformed ports and header values', () => {
  assert.deepEqual(connectionFrom({ port: 1234, csrfToken: 'synthetic' }), { port: 1234, csrfToken: 'synthetic' });
  for (const value of [null, {}, { port: '1234', csrfToken: 'x' }, { port: 65536, csrfToken: 'x' }, { port: 1, csrfToken: 'x\r\nx: y' }]) {
    assert.equal(connectionFrom(value), undefined);
  }
});

test('Connect decoder handles fragmented headers, multiple data frames, and end envelopes', () => {
  const frames = new Frames(); const first = envelope({ updates: {} });
  assert.deepEqual(frames.push(first.subarray(0, 3)), []);
  assert.deepEqual(frames.push(Buffer.concat([first.subarray(3), envelope({ deletes: [] }), envelope({}, 2)])), [
    { flags: 0, value: { updates: {} } }, { flags: 0, value: { deletes: [] } }, { flags: 2, value: {} },
  ]);
  const oversized = Buffer.alloc(5); oversized.writeUInt32BE(9 * 1024 * 1024, 1);
  assert.throws(() => new Frames().push(oversized));
  assert.throws(() => new Frames().push(envelope({}, 1)));
  assert.throws(() => new Frames().push(envelope([])));
});

test('summary uses conversation routing ID, whole-turn timestamps, children, and termination outcomes', () => {
  const running = summary(id, { ...summaryData(), status: 1, hasActiveChildren: true }, 3000)!;
  assert.equal(running.status, 'running'); assert.equal(running.conversationId, id);
  assert.equal(running.startedAt, 1000); assert.equal(running.endedAt, undefined);
  for (const [reason, expected] of [[1, 'failed'], [2, 'cancelled'], [4, 'completed']] as const) {
    const done = summary(id, { ...summaryData(), status: 1, latestExecutorTerminationReason: reason }, 3000)!;
    assert.equal(done.status, expected); assert.equal(done.endedAt, 2000);
  }
  assert.equal(summary(id, { ...summaryData(), interrupted: true }, 3000)?.status, 'interrupted');
  assert.equal(summary(id, { ...summaryData(), cloud: true }, 3000), undefined);
  assert.equal(summary(id, { ...summaryData(), trajectoryMetadata: { parentConversationId: secondId } }, 3000), undefined);
  assert.equal(summary(id, summaryData(1000, 999), 3000), undefined);
  assert.equal(summary('bad', summaryData(), 3000), undefined);
});

test('metadata aggregates each generation once within its user turn, with per-model breakdown', () => {
  const data = { generatorMetadata: [generation([1, 2]), generation([3], '40', '5', 'Claude'), generation([9], '9999')] };
  const usage = turnUsage(data, 0, 8);
  assert.equal(usage.inputTokens, 140); assert.equal(usage.outputTokens, 25);
  assert.equal(usage.model, 'Claude'); assert.equal(usage.usagePartial, false);
  assert.deepEqual(usage.modelUsage, [{ model: 'Gemini', inputTokens: 100, outputTokens: 20 }, { model: 'Claude', inputTokens: 40, outputTokens: 5 }]);
  assert.equal(usage.costUsd, undefined); // Credits/modelCost are not established USD prices.
  assert.equal(turnUsage(data, 8).inputTokens, 9999);
  assert.doesNotMatch(JSON.stringify(usage), /Private|model-call|systemPrompt/);
});

test('preserves unknown versus zero counts and marks unassignable or incomplete usage partial', () => {
  assert.equal(count('9007199254740993'), undefined); assert.equal(count('-1'), undefined); assert.equal(count(1.5), undefined);
  assert.equal(count('0'), 0);
  const usage = turnUsage({ generatorMetadata: [generation([1], '0', null), generation([2, 9]), { chatModel: { usage: { inputTokens: '900' } } }] }, 0, 8);
  assert.equal(usage.inputTokens, 0); assert.equal(usage.outputTokens, undefined); assert.equal(usage.usagePartial, true);
  assert.equal(turnUsage({ generatorMetadata: [] }, 0).inputTokens, undefined);
  assert.throws(() => turnUsage({ unrelated: 'field' }, 0));
});

test('tracks two full requests, final metadata arrives late, and repeated snapshots never add usage twice', async () => {
  const f = fixture();
  try {
    await f.monitor.tick(); f.time(2000); f.send();
    f.metadata({ generatorMetadata: [generation([1])] }); await f.monitor.tick();
    assert.equal(f.tracker.list()[0]?.inputTokens, 100);
    f.time(6000); f.send(summaryData(1000, 6000, 0, 1)); await f.monitor.tick();
    assert.equal(f.tracker.list()[0]?.endedAt, 6000);
    f.time(10000); f.metadata({ generatorMetadata: [generation([1]), generation([3], '30', '6')] }); await f.monitor.tick();
    assert.equal(f.tracker.list()[0]?.inputTokens, 130); assert.equal(f.tracker.list()[0]?.endedAt, 6000);
    f.send(summaryData(9000, 10000, 5));
    f.metadata({ generatorMetadata: [generation([1]), generation([3], '30', '6'), generation([6], '250', '50', 'Claude')] });
    await f.monitor.tick();
    f.time(14000); f.send(summaryData(9000, 14000, 5, 1)); await f.monitor.tick();
    assert.equal(f.tracker.totals().inputTokens.value, 380); assert.equal(f.tracker.totals().outputTokens.value, 76);
    assert.equal(f.tracker.totals().requests, 2);
    assert.equal(f.tracker.list()[0]?.endedAt! - f.tracker.list()[0]?.startedAt!, 5000);
    f.time(18000); await f.monitor.tick();
    assert.equal(f.tracker.totals().inputTokens.value, 380);
    const restored = new Tracker(); restored.restore(f.tracker.serialize());
    assert.deepEqual(restored.totals(), f.tracker.totals());
    assert.doesNotMatch(JSON.stringify(restored.serialize()), /Private|synthetic-test-token|systemPrompt/);
  } finally { f.monitor.dispose(); }
});

test('a new question saves the interrupted duration, retains tokens, and never reopens the prior turn', async () => {
  const f = fixture();
  try {
    await f.monitor.tick(); f.time(2000); f.send();
    f.metadata({ generatorMetadata: [generation([1])] }); await f.monitor.tick();
    const firstId = f.tracker.list()[0]!.id;
    f.time(8000); f.send(summaryData(6000, 8000, 5)); // Receipt is later than the actual interruption.
    const first = f.tracker.get(firstId)!;
    assert.equal(first.status, 'interrupted'); assert.equal(first.endedAt, 6000);
    assert.equal(first.endedAt! - first.startedAt, 5000); assert.equal(first.inputTokens, 100);
    f.metadata({ generatorMetadata: [generation([1], '100', '25'), generation([6], '50', '5')] });
    await f.monitor.tick();
    assert.equal(f.tracker.get(firstId)?.outputTokens, 25);
    assert.equal(f.tracker.get(firstId)?.endedAt, 6000);
    f.time(10000); f.send(summaryData(1000, 10000, 0));
    assert.equal(f.tracker.get(firstId)?.status, 'interrupted');
    assert.equal(f.tracker.get(firstId)?.endedAt, 6000);
    f.send(summaryData(1000, 10000, 0, 1));
    assert.equal(f.tracker.get(firstId)?.status, 'interrupted');
    assert.equal(f.tracker.get(firstId)?.endedAt, 6000);
    const restored = new Tracker(); restored.restore(f.tracker.serialize());
    assert.equal(restored.get(firstId)?.endedAt, 6000);
    assert.equal(restored.get(firstId)?.inputTokens, 100); assert.equal(restored.get(firstId)?.outputTokens, 25);
  } finally { f.monitor.dispose(); }
});

test('provider interruption timestamps are saved, and repeated terminal updates leave duration fixed', async () => {
  const f = fixture();
  try {
    await f.monitor.tick(); f.time(2000); f.send();
    f.time(7000); f.send({ ...summaryData(1000, 5000), interrupted: true });
    assert.equal(f.tracker.list()[0]?.status, 'interrupted'); assert.equal(f.tracker.list()[0]?.endedAt, 5000);
    f.time(10000); f.send({ ...summaryData(1000, 10000), interrupted: true });
    assert.equal(f.tracker.list()[0]?.endedAt, 5000);
    const restored = new Tracker(); restored.restore(f.tracker.serialize());
    assert.equal(restored.list()[0]?.endedAt, 5000);
  } finally { f.monitor.dispose(); }
});

test('a new question does not fabricate a duration for older interrupted history after reload', async () => {
  const f = fixture();
  try {
    await f.monitor.tick(); f.time(2000); f.send();
    const saved = f.tracker.serialize(); f.monitor.reset(); f.tracker.restore(saved);
    await f.monitor.tick(); f.time(8000); f.send(summaryData(6000, 8000, 5));
    const old = f.tracker.list().find(record => record.startedAt === 1000)!;
    assert.equal(old.endedAt, undefined); assert.equal(old.status, 'interrupted');
  } finally { f.monitor.dispose(); }
});

test('disconnect freezes timers; stale initial running state cannot resume them; newer activity can', async () => {
  const f = fixture();
  try {
    await f.monitor.tick(); f.time(2000); f.send();
    f.close(); assert.equal(f.tracker.list()[0]?.status, 'interrupted');
    assert.equal(f.tracker.list()[0]?.endedAt, undefined); assert.equal(f.live()?.state, 'retrying');
    f.time(7000); await f.monitor.tick(); assert.equal(f.connections(), 2);
    f.send(); assert.equal(f.tracker.list()[0]?.status, 'interrupted');
    f.send(summaryData(1000, 7000)); assert.equal(f.tracker.list()[0]?.status, 'running');
    assert.equal(f.tracker.totals().requests, 1);
    f.raw({ deletes: [id] }); assert.equal(f.tracker.list()[0]?.status, 'interrupted');
  } finally { f.monitor.dispose(); }
});

test('skips historical turns, tolerates empty streams, and clearing prevents reimport', async () => {
  const f = fixture();
  try {
    await f.monitor.tick(); f.raw({}); assert.equal(f.live()?.state, 'connected');
    f.send(summaryData(100, 200, 0, 1)); assert.equal(f.tracker.list().length, 0);
    f.time(2000); f.send(); assert.equal(f.tracker.list().length, 1);
    f.time(3000); f.monitor.reset(); f.tracker.clear(); await f.monitor.tick();
    f.send(); assert.equal(f.tracker.list().length, 0);
    f.time(5000); f.send(summaryData(4000, 5000, 3)); assert.equal(f.tracker.list().length, 1);
  } finally { f.monitor.dispose(); }
});

test('unavailable metadata preserves timing and counts, and inactive extensions are not activated', async () => {
  const f = fixture();
  try {
    f.target(); await f.monitor.tick(); assert.equal(f.live()?.state, 'missing'); assert.equal(f.connections(), 0);
    f.target({ isActive: false }); await f.monitor.tick(); assert.equal(f.live()?.state, 'waiting');
    f.target({ isActive: true, exports: {} }); await f.monitor.tick(); assert.equal(f.live()?.state, 'unsupported');
    f.target({ isActive: true, exports: { port: 123, csrfToken: 'test' } }); await f.monitor.tick();
    f.time(2000); f.send(); f.metadata({ generatorMetadata: [generation([1])] }); await f.monitor.tick();
    f.time(6000); f.metadata({ error: 'unsupported' }); await f.monitor.tick();
    assert.equal(f.live()?.usage, 'unavailable'); assert.equal(f.tracker.totals().inputTokens.value, 100);
    assert.equal(f.tracker.list()[0]?.status, 'running');
  } finally { f.monitor.dispose(); }
});

test('late partial snapshots preserve consistent totals and per-model usage', () => {
  const tracker = new Tracker();
  const parsed = summary(id, summaryData(), 3000)!;
  const record = { ...parsed, source: 'integration' as const, model: 'Gemini', antigravity: { conversationId: id, stepIndex: 0 },
    inputTokens: 100, outputTokens: 20, modelUsage: [{ model: 'Gemini', inputTokens: 100, outputTokens: 20 }], usagePartial: false };
  tracker.syncAntigravity(record);
  tracker.syncAntigravity({ ...record, inputTokens: 90, outputTokens: 30, modelUsage: [{ model: 'Gemini', inputTokens: 90, outputTokens: 30 }] });
  assert.equal(tracker.totals().inputTokens.value, 100); assert.equal(tracker.totals().outputTokens.value, 20);
  assert.deepEqual(tracker.list()[0]?.modelUsage, record.modelUsage); assert.equal(tracker.list()[0]?.usagePartial, true);
});

test('archived automatic rows cannot be replayed after reload', () => {
  const tracker = new Tracker();
  const first = summary(id, summaryData(1000, 2000, 0, 1), 3000)!;
  const old = { ...first, source: 'integration' as const, model: 'Gemini', inputTokens: 10, antigravity: { conversationId: id, stepIndex: 0 } };
  tracker.syncAntigravity(old);
  for (let i = 0; i < Tracker.limit; i++) {
    tracker.apply({ type: 'start', requestId: `newer-${i}`, model: 'Manual', at: 3000 + i }, 'manual');
    tracker.apply({ type: 'finish', requestId: `newer-${i}`, at: 4000 + i, status: 'completed' }, 'manual');
  }
  const restored = new Tracker(); restored.restore(tracker.serialize());
  assert.equal(restored.get(old.id), undefined);
  assert.equal(restored.syncAntigravity(old), false);
  assert.equal(restored.totals().inputTokens.value, 10);
  assert.equal(restored.totals().requests, Tracker.limit + 1);
});

test('local HTTP integration authenticates fixed read-only endpoints and reads fragmented summary plus token metadata', async () => {
  const paths: string[] = []; const bodies: Buffer[] = [];
  let stream: http.ServerResponse | undefined;
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-codeium-csrf-token'], 'synthetic-local-token');
    assert.equal(request.method, 'POST'); paths.push(request.url!);
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      if (request.url?.endsWith('JetboxSubscribeToSummaries')) {
        stream = response; response.writeHead(200, { 'content-type': 'application/connect+json' });
        const frame = envelope({ updates: { [id]: summaryData() } });
        response.write(frame.subarray(0, 2)); response.write(frame.subarray(2));
      } else {
        assert.deepEqual(JSON.parse(bodies.at(-1)!.toString()), { cascadeId: id });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ generatorMetadata: [generation([1])] }));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connection = { port: (server.address() as import('node:net').AddressInfo).port, csrfToken: 'synthetic-local-token' };
  let resolveMessage: (value: unknown) => void = () => {};
  const message = new Promise<unknown>(resolve => { resolveMessage = resolve; });
  let closeCount = 0;
  const subscription = subscribe(connection, resolveMessage, () => { closeCount++; });
  try {
    const received = await message;
    assert.deepEqual(received, { updates: { [id]: summaryData() } });
    assert.deepEqual(bodies[0], Buffer.from([0, 0, 0, 0, 2, 123, 125]));
    const data = await generatorMetadata(connection, id, new AbortController().signal);
    assert.equal(turnUsage(data, 0).inputTokens, 100);
    assert.deepEqual(paths, ['/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries', '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata']);
    subscription.dispose(); assert.equal(closeCount, 0);
  } finally {
    subscription.dispose(); stream?.destroy(); server.closeAllConnections(); server.close(); await once(server, 'close');
  }
});

test('unary errors never disclose server payloads or the CSRF value and cancellation releases the request', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'private-response' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connection = { port: (server.address() as import('node:net').AddressInfo).port, csrfToken: 'synthetic-sensitive-value' };
  try {
    await assert.rejects(generatorMetadata(connection, id, new AbortController().signal), error => {
      assert.doesNotMatch(String(error), /private-response|synthetic-sensitive/); return true;
    });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(generatorMetadata(connection, id, abort.signal));
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});
