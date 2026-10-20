import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function dashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('dashboard.css')}"><title>Antigravity Usage</title></head>
<body><main>
  <header><div><p class="eyebrow">ANTIGRAVITY / USAGE</p><h1>Your work, measured.</h1><p class="muted">Model activity and the time behind each request.</p></div>
  <button id="export" class="secondary">Export JSON ↗</button></header>
  <section class="connection" aria-label="Data source"><span class="dot"></span><div><strong id="connection">Waiting for Antigravity</strong><p id="connection-detail">Open Google Antigravity and send a new request to begin automatic tracking.</p><button id="inspect" class="text-button">Inspect installed integration</button></div></section>
  <section class="live-card"><div><p class="eyebrow">ACTIVE / LATEST REQUEST MODEL <span id="model-source"></span></p><h2 id="model">No model reported</h2><p id="live-detail" class="muted">No active requests</p></div><div class="live-actions"><strong id="live-time">—</strong><button id="start">Start manual timer</button><button id="finish" class="secondary" hidden>Finish timer</button><button id="cancel" class="secondary" hidden>Cancel timer</button><button id="select" class="text-button">Choose manual model</button></div></section>
  <section class="panel"><div class="section-heading"><h2>Overall recorded usage</h2><span class="muted">Since tracking began · resets when history is cleared</span></div><div class="lifetime"><div><p class="muted">Input tokens</p><strong id="lifetime-input">—</strong><small id="lifetime-input-coverage">Not reported</small></div><div><p class="muted">Output tokens</p><strong id="lifetime-output">—</strong><small id="lifetime-output-coverage">Not reported</small></div><div><p class="muted">Requests</p><strong id="lifetime-requests">0</strong><small>Totals survive detailed-history retention</small></div></div></section>
  <div class="section-heading"><h2>Recent history overview</h2><label>Period <select id="range"><option value="today">Today</option><option value="week">Last 7 days</option><option value="all">All retained history</option></select></label></div>
  <section class="metrics" aria-label="Usage totals">
    <article><p>Requests</p><strong id="requests">0</strong><small id="outcomes">No activity yet</small></article>
    <article><p>Input tokens</p><strong id="input">—</strong><small id="input-coverage">Not reported</small></article>
    <article><p>Output tokens</p><strong id="output">—</strong><small id="output-coverage">Not reported</small></article>
    <article><p>Average completion time</p><strong id="average">—</strong><small>Completed requests only</small></article>
  </section>
  <div class="columns"><section class="panel"><div class="section-heading"><h2>Daily activity</h2><span class="muted">Last 7 days · local time</span></div><div id="chart" class="chart"></div></section>
  <section class="panel"><h2>Reported cost</h2><strong id="cost" class="cost">—</strong><p id="cost-coverage" class="muted">No cost data reported.</p><p class="muted">Provider-reported USD only. Subscription quota and remaining credits are not available.</p></section></div>
  <section class="panel"><div class="section-heading"><h2>By model</h2><span class="muted">Selected period</span></div><div class="table-wrap"><table><thead><tr><th>Model</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Avg. duration</th></tr></thead><tbody id="models"></tbody></table></div></section>
  <section class="panel"><div class="section-heading"><h2>Recent requests</h2><span class="muted">Latest 100 in selected period</span></div><p id="empty" class="empty">Your first request starts here.<br><span class="muted">Send a new request in Google Antigravity, or start a manual timer.</span></p><div class="table-wrap"><table id="history-table" hidden><thead><tr><th>Started</th><th>Model</th><th>Duration</th><th>Tokens in / out</th><th>Status</th><th>Source</th></tr></thead><tbody id="history"></tbody></table></div></section>
  <footer><span>Stored locally · up to 1,000 finished requests · no prompts or responses stored</span><button id="clear" class="text-button">Clear history</button></footer>
</main><script nonce="${nonce}" src="${asset('dashboard.js')}"></script></body></html>`;
}
