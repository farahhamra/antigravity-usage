import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { Tracker } from '../src/tracker';

function dashboard() {
  const exported: Record<string, any> = {};
  const compiled = readFileSync(join(__dirname, '../src/dashboard.js'), 'utf8');
  const vscode = { Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') } };
  vm.runInNewContext(compiled, { exports: exported, require: (name: string) => name === 'vscode' ? vscode : require(name) });
  const html = exported.dashboardHtml({ asWebviewUri: (uri: string) => uri, cspSource: 'test-resource:' }, {});
  const messages: unknown[] = [];
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  (dom.window as any).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => messages.push(message), getState: () => undefined, setState: () => undefined,
  });
  dom.window.eval(readFileSync(join(process.cwd(), 'media/dashboard.js'), 'utf8'));
  const send = (tracker: Tracker, now: number, integrationSeen = true) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'snapshot', records: tracker.list(), totals: tracker.totals(), now, selectedModel: tracker.selectedModel, selectionSource: tracker.selectionSource, integrationSeen },
  }));
  return { dom, send, messages, text: (id: string) => dom.window.document.getElementById(id)!.textContent };
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
    assert.match(page.text('connection')!, /integration pending/);
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
