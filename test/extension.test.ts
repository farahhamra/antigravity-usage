import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import type { UsageApi } from '../src/extension';

/** A VS Code API boundary double; this is not an Electron extension-host test. */
function activate(saved?: unknown) {
  const commands = new Map<string, () => Promise<void>>();
  const subscriptions: { dispose(): void }[] = [];
  const errors: string[] = [];
  const messages: any[] = [];
  const log: string[] = [];
  let now = 1000;
  let receive: (message: unknown) => void = () => undefined;
  const disposable = { dispose() {} };
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { One: 1 },
    Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/'), file: (path: string) => path },
    commands: { registerCommand: (id: string, fn: () => Promise<void>) => { commands.set(id, fn); return disposable; } },
    extensions: { getExtension: (id: string) => id === 'google.google-antigravity' ? { packageJSON: { version: '1.8.0' }, isActive: false } : undefined },
    window: {
      createOutputChannel: () => ({ ...disposable, appendLine: (message: string) => log.push(message), show() {} }),
      createStatusBarItem: () => ({ ...disposable, show() {} }),
      showInputBox: async () => 'Manual model',
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message: string) => { errors.push(message); },
      showWarningMessage: async () => 'Delete history',
      showSaveDialog: async () => undefined,
      createWebviewPanel: () => ({
        ...disposable, reveal() {}, onDidDispose: () => disposable,
        webview: {
          html: '', postMessage: async (message: unknown) => { messages.push(message); },
          onDidReceiveMessage: (fn: (message: unknown) => void) => { receive = fn; return disposable; },
        },
      }),
    },
  };
  const exports: Record<string, any> = {};
  vm.runInNewContext(readFileSync(join(__dirname, '../src/extension.js'), 'utf8'), {
    exports, Buffer, Date: class extends Date { static now() { return now; } },
    setInterval: () => 1, clearInterval: () => undefined,
    require: (name: string) => name === 'vscode' ? vscode : name === './dashboard'
      ? { dashboardHtml: () => '<html></html>' } : name.startsWith('./') ? require(`../src/${name.slice(2)}`) : require(name),
  });
  const api = exports.activate({
    subscriptions, extensionUri: '/extension',
    globalState: { get: () => saved, update: async (_key: string, value: unknown) => { saved = structuredClone(value); } },
  }) as UsageApi;
  return {
    api, commands, errors, messages, log, saved: () => saved as any,
    time: (time: number) => { now = time; }, ready: () => receive({ type: 'ready' }),
    dispose: () => subscriptions.forEach(item => item.dispose()),
  };
}

test('activation connects manual commands, storage, dashboard snapshots, and target detection', async () => {
  const host = activate();
  try {
    await host.commands.get('antigravityUsage.startTimer')!();
    host.time(6400);
    await host.commands.get('antigravityUsage.finishTimer')!();
    const record = host.saved().records[0];
    assert.equal(record.model, 'Manual model');
    assert.equal(record.source, 'manual');
    assert.equal(record.endedAt - record.startedAt, 5400);
    assert.equal(record.inputTokens, undefined);
    await host.commands.get('antigravityUsage.openDashboard')!();
    host.ready();
    assert.equal(host.messages.at(-1).targetInstalled, true);
    assert.equal(host.messages.at(-1).totals.requests, 1);
    assert.equal(host.messages.at(-1).integrationSeen, false);
    assert.deepEqual(host.errors, []);
  } finally { host.dispose(); }
});

test('public integration API persists exact token counts and rejects invalid usage', async () => {
  const host = activate();
  try {
    await host.api.record({ type: 'start', requestId: 'real-event', at: 1000, model: 'Model B' });
    await host.api.record({ type: 'finish', requestId: 'real-event', at: 7500, status: 'completed', inputTokens: 321, outputTokens: 65 });
    const record = host.saved().records[0];
    assert.equal(record.source, 'integration');
    assert.equal(record.inputTokens, 321); assert.equal(record.outputTokens, 65);
    const saved = host.saved();
    await assert.rejects(() => host.api.record({ type: 'usage', requestId: 'real-event', at: 8000, inputTokens: 500 }));
    assert.deepEqual(host.saved(), saved);
  } finally { host.dispose(); }
});

test('corrupt storage is preserved until confirmed clear resets it', async () => {
  const corrupt = { version: 900, records: [] };
  const host = activate(corrupt);
  try {
    assert.equal(host.errors.length, 1);
    await assert.rejects(() => host.api.record({ type: 'model', model: 'Model B' }));
    assert.deepEqual(host.saved(), corrupt);
    await host.commands.get('antigravityUsage.clearData')!();
    await host.api.record({ type: 'model', model: 'Model B' });
    assert.equal(host.saved().selectedModel, 'Model B');
    assert.equal(host.saved().version, 1);
  } finally { host.dispose(); }
});
