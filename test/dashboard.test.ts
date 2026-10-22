import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { Tracker } from '../src/tracker';
import { groupQuotaFamilies } from '../src/antigravity/quota';

function dashboard() {
  const exported: Record<string, any> = {};
  const compiled = readFileSync(join(__dirname, '../src/dashboard.js'), 'utf8');
  const vscode = { Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') } };
  vm.runInNewContext(compiled, { exports: exported, require: (name: string) => name === 'vscode' ? vscode : require(name) });
  const html = exported.dashboardHtml({ asWebviewUri: (uri: string) => uri, cspSource: 'test-resource:' }, {});
  const messages: unknown[] = [];
  let viewState: any;
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  (dom.window as any).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => messages.push(message), getState: () => viewState, setState: (value: unknown) => { viewState = value; },
  });
  dom.window.eval(readFileSync(join(process.cwd(), 'media/dashboard.js'), 'utf8'));
  const send = (tracker: Tracker, now: number, integrationSeen = true, liveStatus?: { state: string; usage: string }, extra: Record<string, unknown> = {}) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'snapshot', records: tracker.list(), totals: tracker.totals(), now, selectedModel: tracker.selectedModel, selectionSource: tracker.selectionSource, integrationSeen, liveStatus, ...extra },
  }));
  return { dom, send, messages, viewState: () => viewState, text: (id: string) => dom.window.document.getElementById(id)!.textContent };
}

test('renders overall totals, cumulative live usage, and per-request input/output tokens', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = new Date(2026, 9, 20, 12).getTime();
    tracker.apply({ type: 'start', requestId: '1', model: 'Model A', at: now - 8000 }, 'integration');
    tracker.apply({ type: 'usage', requestId: '1', at: now, inputTokens: 120, outputTokens: 30 }, 'integration');
    page.send(tracker, now);
    assert.equal(page.text('lifetime-input'), '120'); assert.equal(page.text('lifetime-output'), '30');
    assert.equal(page.text('input'), '120'); assert.equal(page.text('live-time'), '8s');
    assert.match(page.text('live-detail')!, /120 input \/ 30 output/);
    assert.match(page.text('history')!, /120 \/ 30/);
    assert.match(page.text('models')!, /Model A/);
    assert.match(page.text('connection')!, /Integration events received/);
  } finally { page.dom.window.close(); }
});

test('manual timer shows unavailable tokens, and all-history selection includes older records', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = new Date(2026, 9, 20, 12).getTime();
    tracker.apply({ type: 'start', requestId: 'old', model: 'Model A', at: now - 86400000 }, 'manual');
    tracker.apply({ type: 'finish', requestId: 'old', at: now - 86395000, status: 'completed' }, 'manual');
    page.send(tracker, now, false);
    assert.equal(page.text('requests'), '0'); assert.equal(page.text('lifetime-requests'), '1');
    assert.equal(page.text('lifetime-input'), '—'); assert.equal(page.text('input-coverage'), 'Not reported');
    const select = page.dom.window.document.getElementById('range') as HTMLSelectElement;
    select.value = 'all'; select.dispatchEvent(new page.dom.window.Event('change'));
    assert.equal(page.text('requests'), '1'); assert.equal(page.text('average'), '5s');
    assert.match(page.text('history')!, /— \/ —/);
    assert.match(page.text('connection')!, /Waiting for Antigravity/);
  } finally { page.dom.window.close(); }
});

test('renders external model names as text and sends the finish action', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = Date.now();
    const model = '<img src=x onerror=alert(1)>';
    tracker.apply({ type: 'start', requestId: '1', model, at: now }, 'manual');
    page.send(tracker, now, false);
    assert.equal(page.text('model'), model);
    assert.equal(page.dom.window.document.querySelectorAll('img').length, 0);
    page.dom.window.document.getElementById('finish')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"action":"finish"}');
    const csp = page.dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!;
    assert.match(csp, /default-src 'none'/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  } finally { page.dom.window.close(); }
});

test('labels partial usage totals and preserves legitimate zero usage', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = Date.now();
    for (const id of ['known', 'unknown']) tracker.apply({ type: 'start', requestId: id, model: 'A', at: now }, 'integration');
    tracker.apply({ type: 'usage', requestId: 'known', at: now, inputTokens: 0 }, 'integration');
    page.send(tracker, now);
    assert.equal(page.text('input'), '0');
    assert.match(page.text('input-coverage')!, /1 of 2 requests · partial total/);
    assert.equal(page.text('output'), '—');
  } finally { page.dom.window.close(); }
});

test('renders automatic connection states, incomplete metadata, and per-model splits for one turn', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = Date.now();
    tracker.syncAntigravity({ id: 'antigravity:test', source: 'integration', model: 'Claude', startedAt: now - 8000, updatedAt: now,
      status: 'completed', endedAt: now, antigravity: { conversationId: '12345678-1234-1234-1234-123456789abc', stepIndex: 0 },
      inputTokens: 150, outputTokens: 30, usagePartial: true,
      modelUsage: [{ model: 'Gemini', inputTokens: 100, outputTokens: 20 }, { model: 'Claude', inputTokens: 50, outputTokens: 10 }],
    });
    page.send(tracker, now, false, { state: 'connected', usage: 'available' });
    assert.match(page.text('connection')!, /Live Antigravity activity connected/);
    assert.match(page.text('model-source')!, /REPORTED MODEL/);
    assert.match(page.text('lifetime-input-coverage')!, /incomplete/);
    assert.match(page.text('history')!, /Gemini \+ Claude/);
    const rows = [...page.dom.window.document.querySelectorAll('#models tr')];
    assert.equal(rows.length, 2);
    const gemini = rows.find(row => row.textContent!.includes('Gemini'))!;
    assert.equal(gemini.children[2]!.childNodes[0]!.textContent, '100');
    page.send(tracker, now, false, { state: 'connected', usage: 'unavailable' });
    assert.match(page.text('connection-detail')!, /token metadata could not be read/);
    page.send(tracker, now, false, { state: 'retrying', usage: 'unavailable' });
    assert.match(page.text('connection')!, /disconnected/);
  } finally { page.dom.window.close(); }
});

test('monthly heatmap counts local calendar days, navigates years, and preserves its selected month', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = new Date(2026, 11, 21, 12).getTime();
    tracker.apply({ type: 'start', requestId: 'a', model: 'A', at: new Date(2026, 11, 1, 0, 15).getTime() }, 'manual');
    tracker.apply({ type: 'start', requestId: 'b', model: 'A', at: new Date(2026, 10, 30, 23, 50).getTime() }, 'manual');
    page.send(tracker, now);
    const doc = page.dom.window.document;
    assert.equal(doc.querySelectorAll('.calendar-day').length, 31);
    const cell = doc.querySelector('[data-date="2026-12-01"]') as HTMLButtonElement;
    assert.equal(cell.dataset.count, '1'); assert.match(cell.className, /heat-4/);
    cell.click(); cell.focus();
    assert.match(page.text('activity-detail')!, /1 request/);
    const focused = doc.querySelector('[data-date="2026-12-01"]') as HTMLButtonElement; focused.focus();
    page.send(tracker, now + 1000);
    assert.equal(doc.activeElement, focused); // A timer tick must not replace focused calendar cells.
    doc.getElementById('calendar-next')!.click();
    assert.match(page.text('calendar-month')!, /January 2027/);
    assert.equal(page.viewState().calendarMonth, '2027-01');
    page.send(tracker, now + 2000); assert.match(page.text('calendar-month')!, /January 2027/);
    doc.getElementById('calendar-today')!.click(); assert.match(page.text('calendar-month')!, /December 2026/);
  } finally { page.dom.window.close(); }
});

test('subscription markers repeat monthly, clamp the 31st in leap February, and do not appear before subscription', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = new Date(2024, 1, 20, 12).getTime();
    const subscription = { startDate: '2024-01-31', marker: 'monthly' };
    page.send(tracker, now, true, undefined, { subscription });
    const doc = page.dom.window.document;
    assert.equal(doc.querySelectorAll('.calendar-day').length, 29);
    assert.equal((doc.querySelector('.subscription-day') as HTMLElement).dataset.date, '2024-02-29');
    doc.getElementById('calendar-prev')!.click();
    assert.equal((doc.querySelector('.subscription-day') as HTMLElement).dataset.date, '2024-01-31');
    assert.match(doc.querySelector('.subscription-day')!.getAttribute('aria-label')!, /Subscription started/);
    doc.getElementById('calendar-prev')!.click(); assert.equal(doc.querySelectorAll('.subscription-day').length, 0);
    doc.getElementById('calendar-today')!.click();
    page.send(tracker, now, true, undefined, { subscription: { ...subscription, marker: 'startDate' } });
    assert.equal(doc.querySelectorAll('.subscription-day').length, 0);
    doc.getElementById('subscription')!.click(); assert.equal(JSON.stringify(page.messages.at(-1)), '{"action":"subscription"}');
  } finally { page.dom.window.close(); }
});

test('non-leap February has 28 days and a recurring marker on the last day', () => {
  const page = dashboard();
  try {
    page.send(new Tracker(), new Date(2025, 1, 10, 12).getTime(), true, undefined, { subscription: { startDate: '2024-01-31', marker: 'monthly' } });
    assert.equal(page.dom.window.document.querySelectorAll('.calendar-day').length, 28);
    assert.equal((page.dom.window.document.querySelector('.subscription-day') as HTMLElement).dataset.date, '2025-02-28');
  } finally { page.dom.window.close(); }
});

test('one quota panel shows three family rows, weekly/five-hour limits, resets and stale data', () => {
  const page = dashboard();
  try {
    const now = Date.now();
    const quota = { state: 'ready', refreshing: false, updatedAt: now, entries: groupQuotaFamilies([
      { label: 'Gemini Flash 3.8 High', scope: 'group', windows: [{ label: 'Weekly limit', period: 'weekly', remainingFraction: 0.75, resetAt: now + 3600000 }] },
      { label: 'Gemini 3.8 Flash Low', scope: 'group', windows: [{ label: 'Weekly limit', period: 'weekly', remainingFraction: 0.75 }] },
      { label: 'Gemini Argon 4 (1M)', scope: 'group', windows: [{ label: '5-hour limit', period: '5h', remainingFraction: 0 }] },
      { label: '<img src=x onerror=alert(1)>', scope: 'group', windows: [{ label: 'Weekly limit', period: 'weekly', remainingFraction: 0.1, resetAt: now - 1 }] },
    ]) };
    page.send(new Tracker(), now, true, undefined, { quota });
    assert.match(page.text('quotas')!, /75% remaining/); assert.match(page.text('quotas')!, /25% used/);
    assert.match(page.text('quotas')!, /Limit reached/); assert.match(page.text('quotas')!, /Quota not reported/);
    assert.match(page.text('quotas')!, /Reset due/);
    const doc = page.dom.window.document;
    assert.equal(doc.querySelectorAll('#quotas').length, 1);
    assert.equal(doc.querySelectorAll('.quota-card').length, 0);
    assert.equal(doc.querySelectorAll('.quota-row').length, 3);
    assert.equal(doc.querySelectorAll('.quota-window').length, 6);
    assert.deepEqual(Array.from(doc.querySelectorAll('.quota-title h3'), el => el.textContent), ['Gemini Flash 3.8', 'Gemini Argon 4', 'Other models']);
    assert.doesNotMatch(page.text('quotas')!, /High|Low|1M|img/);
    for (const row of doc.querySelectorAll('.quota-row')) { assert.match(row.textContent!, /Weekly/); assert.match(row.textContent!, /5 hours/); }
    assert.equal((page.dom.window.document.querySelector('.quota-window meter') as HTMLMeterElement).value, 25);
    assert.equal(page.dom.window.document.querySelectorAll('img').length, 0);
    page.send(new Tracker(), now + 100000, true, undefined, { quota });
    assert.match(page.text('quota-status')!, /Last known limits/);
    assert.match(page.text('quotas')!, /75% remaining/); // Never silently reset cached limits.
    page.dom.window.document.getElementById('refreshQuota')!.click();
    assert.equal(JSON.stringify(page.messages.at(-1)), '{"action":"refreshQuota"}');
  } finally { page.dom.window.close(); }
});

test('interrupted durations remain fixed in history after reload and later dashboard ticks', () => {
  const page = dashboard();
  try {
    const tracker = new Tracker(); const now = Date.now();
    tracker.syncAntigravity({ id: 'antigravity:interrupted', source: 'integration', model: 'Gemini', startedAt: now - 9000,
      updatedAt: now - 4000, endedAt: now - 4000, status: 'interrupted', inputTokens: 100, outputTokens: 20,
      antigravity: { conversationId: '12345678-1234-1234-1234-123456789abc', stepIndex: 0 } });
    const restored = new Tracker(); restored.restore(tracker.serialize());
    page.send(restored, now); const before = page.text('history');
    assert.match(before!, /5s/); assert.match(before!, /100 \/ 20/);
    page.send(restored, now + 60000); assert.equal(page.text('history'), before);
  } finally { page.dom.window.close(); }
});
