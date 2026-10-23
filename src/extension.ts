import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Tracker } from './tracker';
import { dashboardHtml } from './dashboard';
import { AntigravityMonitor, LiveStatus } from './antigravity/monitor';
import { connectionFrom, TARGET_ID } from './antigravity/transport';
import { groupQuotaFamilies, QuotaMonitor, QuotaSnapshot } from './antigravity/quota';
import { subscriptionDate } from './settings';

export interface UsageApi {
  version: 1;
  /** Cumulative usage events. A request is an entire agent turn, including tool calls. */
  record(event: unknown): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): UsageApi {
  const tracker = new Tracker();
  const output = vscode.window.createOutputChannel('Antigravity Usage');
  context.subscriptions.push(output);
  let storageHealthy = true;
  const previous = context.globalState.get<unknown>('usage.v1');
  if (previous !== undefined) {
    try { tracker.restore(previous); }
    catch {
      storageHealthy = false;
      void vscode.window.showErrorMessage('Antigravity Usage could not read saved history. The original is preserved; clear history to reset it.');
    }
  }
  let panel: vscode.WebviewPanel | undefined;
  let integrationSeen = false;
  let liveStatus: LiveStatus = { state: 'waiting', usage: 'waiting' };
  let quota: QuotaSnapshot = { state: 'waiting', entries: [], refreshing: false };
  let persistQueue = Promise.resolve();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'antigravityUsage.openDashboard';
  status.name = 'Antigravity Usage';
  context.subscriptions.push(status);
  status.show();

  function refresh(): void {
    const records = tracker.list();
    const active = records.filter(r => r.status === 'running');
    const latest = active[0];
    status.text = latest
      ? `$(pulse) ${latest.model.replace(/[\r\n]/g, ' ')} · ${Math.max(0, Math.floor((Date.now() - latest.startedAt) / 1000))}s${active.length > 1 ? ` (${active.length})` : ''}`
      : '$(graph) Antigravity Usage';
    status.tooltip = latest ? 'Tracking request duration. Open the usage dashboard.' : `Antigravity connection: ${liveStatus.state}. Open usage dashboard.`;
    const config = vscode.workspace.getConfiguration('antigravityUsage');
    if (panel) void panel.webview.postMessage({
      type: 'snapshot', records, selectedModel: latest?.model ?? tracker.selectedModel,
      selectionSource: latest?.source ?? tracker.selectionSource, integrationSeen, liveStatus, now: Date.now(),
      targetInstalled: !!vscode.extensions.getExtension(TARGET_ID),
      totals: tracker.totals(), quota: { ...quota, entries: groupQuotaFamilies(quota.entries) },
      subscription: {
        startDate: subscriptionDate(config.get('subscriptionStartDate')),
        marker: config.get('subscriptionMarker') === 'startDate' ? 'startDate' : 'monthly',
      },
    });
  }
  async function save(): Promise<void> {
    if (!storageHealthy) throw new Error('Saved history is unreadable. Clear history before recording new data.');
    const snapshot = tracker.serialize();
    persistQueue = persistQueue.catch(() => undefined).then(() => context.globalState.update('usage.v1', snapshot));
    await persistQueue;
  }
  async function selectModel(): Promise<string | undefined> {
    const model = await vscode.window.showInputBox({
      title: 'Model for manual timing', prompt: 'Enter the model name shown in your Antigravity extension.',
      value: tracker.selectedModel, placeHolder: 'Exact model name',
      validateInput: value => !value.trim() || value.length > 200 ? 'Enter a model name between 1 and 200 characters.' : undefined,
    });
    if (model === undefined) return undefined;
    tracker.apply({ type: 'model', model }, 'manual');
    await save();
    refresh();
    return tracker.selectedModel;
  }
  async function start(): Promise<void> {
    if (tracker.list().some(r => r.source === 'manual' && r.status === 'running')) {
      void vscode.window.showInformationMessage('A manual timer is already running. Finish or cancel it first.');
      return;
    }
    const model = tracker.selectedModel ?? await selectModel();
    if (!model) return;
    tracker.apply({ type: 'start', requestId: randomUUID(), model, at: Date.now() }, 'manual');
    await save();
    refresh();
  }
  async function finish(cancelled = false): Promise<void> {
    const running = tracker.list().find(r => r.source === 'manual' && r.status === 'running');
    if (!running) {
      void vscode.window.showInformationMessage('No manual request timer is running.');
      return;
    }
    tracker.apply({ type: 'finish', requestId: running.id, at: Date.now(), status: cancelled ? 'cancelled' : 'completed' }, 'manual');
    await save();
    refresh();
  }
  async function exportData(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      title: 'Export Antigravity Usage', defaultUri: vscode.Uri.file(join(homedir(), 'antigravity-usage.json')), filters: { JSON: ['json'] },
    });
    if (uri) await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(storageHealthy ? tracker.serialize() : previous, null, 2)));
  }
  async function setSubscriptionDate(): Promise<void> {
    const config = vscode.workspace.getConfiguration('antigravityUsage');
    const value = await vscode.window.showInputBox({
      title: 'Subscription start date', value: config.get<string>('subscriptionStartDate', ''),
      prompt: 'Enter YYYY-MM-DD. Leave blank to remove the calendar marker.', placeHolder: 'YYYY-MM-DD',
      validateInput: value => !value.trim() || subscriptionDate(value.trim()) ? undefined : 'Enter a valid calendar date as YYYY-MM-DD.',
    });
    if (value === undefined) return;
    const date = value.trim();
    if (date && !subscriptionDate(date)) throw new Error('Enter a valid subscription date as YYYY-MM-DD.');
    await config.update('subscriptionStartDate', date, vscode.ConfigurationTarget.Global);
    refresh();
  }
  async function clear(): Promise<void> {
    const answer = await vscode.window.showWarningMessage('Delete all local usage history and active timers?', { modal: true }, 'Delete history');
    if (answer !== 'Delete history') return;
    monitor.reset();
    tracker.clear();
    storageHealthy = true;
    monitor.setPaused(false);
    await save();
    refresh();
  }
  function inspectIntegration(): void {
    const target = vscode.extensions.getExtension(TARGET_ID);
    output.appendLine(`Integration target: ${TARGET_ID}`);
    if (!target) {
      output.appendLine('Target extension is not installed in this VS Code window.');
    } else {
      output.appendLine(`Installed version: ${String(target.packageJSON.version ?? 'unknown')}`);
      output.appendLine(`Active: ${target.isActive}`);
      const exports = target.isActive ? target.exports : undefined;
      output.appendLine(`Public API keys: ${exports && typeof exports === 'object' ? Object.keys(exports).join(', ') || '(none)' : '(not available)'}`);
      let connection;
      try { connection = connectionFrom(exports); } catch { /* Provider exports can change during restart. */ }
      output.appendLine(`Exported backend endpoint: ${connection ? `http://127.0.0.1:${connection.port}` : '(not available)'}`);
      const configuredPort = vscode.workspace.getConfiguration('antigravity').get<unknown>('serverPort');
      output.appendLine(`Configured Antigravity port: ${typeof configuredPort === 'number' && Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535 ? configuredPort : '(automatic or not set)'}`);
      output.appendLine(`Local activity connection: ${liveStatus.state}. Usage metadata: ${liveStatus.usage}.`);
      if (liveStatus.detail) output.appendLine(`Activity diagnostic: ${liveStatus.detail}`);
      output.appendLine(`Model limits: ${quota.state}.`);
      if (quota.detail) output.appendLine(`Limits diagnostic: ${quota.detail}`);
      output.appendLine('Open Antigravity and send a new request. This observer does not activate it or read account credentials.');
    }
    output.show(true);
  }
  const actions: Record<string, () => void | Promise<unknown>> = {
    select: selectModel, start, finish: () => finish(), cancel: () => finish(true), export: exportData, clear, inspect: inspectIntegration,
    subscription: setSubscriptionDate, refreshQuota: () => quotaMonitor.tick(true),
  };
  async function run(action: () => void | Promise<unknown>): Promise<void> {
    try {
      if (!storageHealthy && action !== clear && action !== exportData) throw new Error('Clear unreadable saved history before recording new data.');
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      output.appendLine(message);
      void vscode.window.showErrorMessage(`Antigravity Usage: ${message}`);
    }
  }
  function openDashboard(): void {
    if (panel) { panel.reveal(); refresh(); return; }
    panel = vscode.window.createWebviewPanel('antigravityUsage', 'Antigravity Usage', vscode.ViewColumn.One, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panel.webview.html = dashboardHtml(panel.webview, context.extensionUri);
    panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') refresh();
      if (message?.action === 'subscriptionMode' && ['monthly', 'startDate'].includes(message.value)) {
        void run(async () => {
          await vscode.workspace.getConfiguration('antigravityUsage').update('subscriptionMarker', message.value, vscode.ConfigurationTarget.Global);
          refresh();
        });
      }
      if (typeof message?.action === 'string' && Object.hasOwn(actions, message.action)) void run(actions[message.action]!);
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
  }
  const commands: Record<string, () => void | Promise<unknown>> = {
    openDashboard, selectModel, startTimer: start, finishTimer: () => finish(),
    cancelTimer: () => finish(true), exportData, clearData: clear, inspectIntegration, setSubscriptionDate,
  };
  for (const [name, action] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`antigravityUsage.${name}`, () => run(action)));
  }
  const monitor = new AntigravityMonitor({
    tracker, target: () => vscode.extensions.getExtension(TARGET_ID),
    status: value => { liveStatus = value; refresh(); },
    changed: () => {
      if (!storageHealthy) return;
      refresh();
      void save().catch(() => {
        // Avoid repeating backend errors or accidentally exposing response payloads.
        monitor.setPaused(true);
        output.appendLine('Automatic tracking paused because local history could not be saved. Reload the window to retry.');
        liveStatus = { state: 'paused', usage: 'unavailable' }; refresh();
      });
    },
  });
  monitor.setPaused(!storageHealthy);
  const quotaMonitor = new QuotaMonitor({
    target: () => vscode.extensions.getExtension(TARGET_ID),
    changed: value => { quota = value; refresh(); },
  });
  context.subscriptions.push(monitor, quotaMonitor, vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('antigravityUsage')) refresh();
  }));
  const timer = setInterval(() => { refresh(); void monitor.tick(); void quotaMonitor.tick(); }, 1000);
  context.subscriptions.push({ dispose: () => { clearInterval(timer); panel?.dispose(); } });
  void monitor.tick();
  void quotaMonitor.tick();
  refresh();
  return {
    version: 1,
    async record(event: unknown): Promise<void> {
      if (!storageHealthy) throw new Error('Saved history is unreadable.');
      tracker.apply(event, 'integration');
      integrationSeen = true;
      await save();
      refresh();
    },
  };
}
