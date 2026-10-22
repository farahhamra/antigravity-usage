import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import { fetchQuotas, groupQuotaFamilies, parseModelQuotas, parseQuotaGroups, QuotaEntry, QuotaMonitor, QuotaSnapshot } from '../src/antigravity/quota';
import { subscriptionDate } from '../src/settings';

const modelResponse = (remaining: unknown = '0.75') => ({ userStatus: {
  email: 'private@example.test', name: 'Private name', cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Gemini', quotaInfo: { remainingFraction: remaining, resetTime: '2026-10-21T12:00:00Z' } },
    { label: 'Claude', quotaInfo: { remainingFraction: 0 } },
    { label: 'Unavailable model', disabled: true },
  ] },
} });
const groupsResponse = { response: { groups: [{ displayName: 'Shared premium pool', buckets: [
  { window: '5h', remainingFraction: 0.5, resetTime: '2026-10-21T13:00:00Z' },
  { window: 'weekly', remainingFraction: 1 },
] }] } };

test('quota parsing preserves provider model/group boundaries, zero, missing values, and reset times', () => {
  const models = parseModelQuotas(modelResponse());
  assert.equal(models[0]?.windows[0]?.remainingFraction, 0.75);
  assert.equal(models[0]?.windows[0]?.resetAt, Date.parse('2026-10-21T12:00:00Z'));
  assert.equal(models[1]?.windows[0]?.remainingFraction, 0);
  assert.equal(models[2]?.disabled, true); assert.equal(models[2]?.windows[0]?.remainingFraction, undefined);
  assert.doesNotMatch(JSON.stringify(models), /private@example|Private name/);
  const groups = parseQuotaGroups(groupsResponse);
  assert.equal(groups[0]?.label, 'Shared premium pool'); assert.equal(groups[0]?.scope, 'group');
  assert.deepEqual(groups[0]?.windows.map(w => w.label), ['5-hour limit', 'Weekly limit']);
  assert.equal(groups[0]?.windows[1]?.remainingFraction, 1);
});

test('invalid quota numbers never become full or exhausted limits', () => {
  for (const n of [null, '', '0.5garbage', 'NaN', Infinity, -1, 1.5, true]) {
    assert.equal(parseModelQuotas(modelResponse(n))[0]?.windows[0]?.remainingFraction, undefined);
  }
  assert.deepEqual(parseModelQuotas({}), []); assert.deepEqual(parseQuotaGroups({ response: { groups: [{}] } }), []);
});

test('effort/context variants collapse into three families with independent weekly and five-hour windows', () => {
  const groups = parseQuotaGroups({ response: { groups: [
    ...['Gemini Flash 3.8 High', 'gemini 3.8 flash low', 'Gemini Flash 3.8 Medium (1M context)'].map(displayName => ({
      displayName, buckets: [{ window: 'weekly', remainingFraction: 0.75 }, { window: '5h', remainingFraction: 0 }],
    })),
    { displayName: 'Gemini 4 Argon High', buckets: [{ window: 'weekly', remainingFraction: 1 }, { window: '5h', remainingFraction: 0.5 }] },
    { displayName: 'Claude Sonnet', buckets: [{ window: 'weekly', remainingFraction: 0.2 }] },
    { displayName: 'Claude Opus', buckets: [{ window: 'weekly', remainingFraction: 0.2 }] },
  ] } });
  const before = structuredClone(groups);
  const rows = groupQuotaFamilies(groups);
  assert.deepEqual(rows.map(r => r.label), ['Gemini Flash 3.8', 'Gemini Argon 4', 'Other models']);
  assert.deepEqual(rows.map(r => r.windows.map(w => w.remainingFraction)), [[0.75, 0], [1, 0.5], [0.2, undefined]]);
  assert.ok(rows.every(r => r.windows.length === 2 && r.windows[0]?.label === 'Weekly' && r.windows[1]?.label === '5 hours'));
  assert.ok(rows.every(r => r.windows.every(w => !w.lowestReported)));
  assert.deepEqual(groups, before);
});

test('grouping keeps unclassified periods unknown and never copies generic limits into weekly or five-hour values', () => {
  const entries: QuotaEntry[] = [{ label: 'Gemini Flash 3.8 High', scope: 'model', windows: [{ label: 'Model limit', remainingFraction: 0.7 }] }];
  let rows = groupQuotaFamilies(entries);
  assert.deepEqual(rows[0]?.windows.map(w => w.remainingFraction), [undefined, undefined]);
  assert.equal(rows[0]?.unclassified?.remainingFraction, 0.7);
  entries.push(...parseQuotaGroups({ response: { groups: [{ displayName: 'Gemini Flash 3.8', buckets: [
    { window: 'weekly', remainingFraction: 0.9 }, { window: '5h', remainingFraction: 0.3 },
  ] }] } }));
  rows = groupQuotaFamilies(entries);
  assert.deepEqual(rows[0]?.windows.map(w => w.remainingFraction), [0.9, 0.3]);
  assert.equal(rows[0]?.unclassified, undefined);
  assert.equal(groupQuotaFamilies([]).length, 3);
});

test('differing limits show the lowest complete reading without summing, averaging, or mixing reset times', () => {
  const rows = groupQuotaFamilies(parseQuotaGroups({ response: { groups: [
    { displayName: 'Claude Sonnet', buckets: [{ window: 'weekly', remainingFraction: 0.8, resetTime: '2026-10-22T12:00:00Z' }] },
    { displayName: 'Claude Opus', buckets: [{ window: 'weekly', remainingFraction: 0.1, resetTime: '2026-10-23T12:00:00Z' }] },
    { displayName: 'Unknown', buckets: [{ window: 'weekly' }] },
  ] } }));
  assert.equal(rows[2]?.windows[0]?.remainingFraction, 0.1);
  assert.equal(rows[2]?.windows[0]?.resetAt, Date.parse('2026-10-23T12:00:00Z'));
  assert.equal(rows[2]?.windows[0]?.lowestReported, true);
});

test('quota poller refreshes while idle, throttles manual requests, and marks preserved data stale on failure', async () => {
  let now = 0; let calls = 0; let fail = false; let active = true;
  let state: QuotaSnapshot | undefined;
  const monitor = new QuotaMonitor({
    now: () => now, target: () => ({ isActive: active, exports: { port: 1234, csrfToken: 'synthetic' } }),
    changed: next => { state = next; }, fetch: async () => { calls++; if (fail) throw new Error('private failure'); return parseModelQuotas(modelResponse()); },
  });
  try {
    await monitor.tick(); assert.equal(calls, 1); assert.equal(state?.state, 'ready');
    now = 1000; await monitor.tick(true); assert.equal(calls, 1);
    now = 5000; await monitor.tick(true); assert.equal(calls, 2);
    now = 10000; await monitor.tick(); assert.equal(calls, 2);
    fail = true; now = 35000; await monitor.tick();
    assert.equal(state?.state, 'stale'); assert.equal(state?.updatedAt, 5000);
    assert.equal(state?.entries[0]?.windows[0]?.remainingFraction, 0.75);
    active = false; await monitor.tick(); assert.equal(state?.state, 'stale');
    assert.doesNotMatch(JSON.stringify(state), /private failure|synthetic/);
  } finally { monitor.dispose(); }
});

test('connection changes cancel obsolete polls and disposal suppresses late responses', async () => {
  let port = 1000; let now = 0; let state: QuotaSnapshot | undefined;
  const pending: { signal: AbortSignal; resolve: (entries: ReturnType<typeof parseModelQuotas>) => void }[] = [];
  const monitor = new QuotaMonitor({
    now: () => now, target: () => ({ isActive: true, exports: { port, csrfToken: 'synthetic' } }),
    changed: next => { state = next; }, fetch: (_connection, signal) => new Promise(resolve => pending.push({ signal, resolve })),
  });
  const oldPoll = monitor.tick(); port = 2000; now = 1000; const nextPoll = monitor.tick();
  assert.equal(pending[0]?.signal.aborted, true);
  pending[1]!.resolve(parseModelQuotas(modelResponse(0.2))); await nextPoll;
  pending[0]!.resolve(parseModelQuotas(modelResponse(0.9))); await oldPoll;
  assert.equal(state?.entries[0]?.windows[0]?.remainingFraction, 0.2);
  now = 40000; const lastPoll = monitor.tick(); const before = structuredClone(state); monitor.dispose();
  assert.equal(pending[2]?.signal.aborted, true);
  pending[2]!.resolve(parseModelQuotas(modelResponse(0.9))); await lastPoll;
  assert.deepEqual(state, before);
});

test('fixed quota endpoints authenticate locally and an unavailable summary does not hide per-model quotas', async () => {
  const paths: string[] = [];
  const server = http.createServer((request, response) => {
    paths.push(request.url!); assert.equal(request.headers['x-codeium-csrf-token'], 'synthetic');
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      if (request.url?.endsWith('/GetUserStatus')) {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { metadata: { ideName: 'antigravity' } });
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(modelResponse()));
      } else {
        assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {});
        response.writeHead(404); response.end('private error body');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const entries = await fetchQuotas({ port: (server.address() as import('node:net').AddressInfo).port, csrfToken: 'synthetic' }, new AbortController().signal);
    assert.equal(entries[0]?.windows[0]?.remainingFraction, 0.75);
    assert.deepEqual(paths.sort(), ['/exa.language_server_pb.LanguageServerService/GetUserStatus', '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary']);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});

test('subscription dates validate leap years and actual month lengths without UTC conversion', () => {
  for (const date of ['2024-02-29', '2026-01-31', '2026-10-21']) assert.equal(subscriptionDate(date), date);
  for (const date of ['', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00', '26-10-21', '2026-10-21T00:00:00Z']) assert.equal(subscriptionDate(date), undefined);
});
