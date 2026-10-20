/* All data is inserted through textContent. No model names or external content become HTML. */
(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const text = (id, value) => { byId(id).textContent = value; };
  const number = value => value === null || value === undefined ? '—' : value.toLocaleString();
  const duration = ms => {
    if (ms === null || ms === undefined) return '—';
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  };
  const element = (tag, value, className) => {
    const result = document.createElement(tag);
    if (value !== undefined) result.textContent = value;
    if (className) result.className = className;
    return result;
  };
  const dayStart = timestamp => { const date = new Date(timestamp); date.setHours(0, 0, 0, 0); return date.getTime(); };
  function sum(records, key) {
    const known = records.filter(r => r[key] !== undefined);
    return { value: known.length ? known.reduce((total, r) => total + r[key], 0) : null, known: known.length };
  }
  function average(records) {
    const completed = records.filter(r => r.status === 'completed' && r.endedAt !== undefined);
    return completed.length ? completed.reduce((n, r) => n + r.endedAt - r.startedAt, 0) / completed.length : null;
  }
  function coverage(stat, total) {
    return stat.known ? `Reported for ${stat.known} of ${total} requests${stat.known < total ? ' · partial total' : ''}` : 'Not reported';
  }
  let snapshot;
  const previous = vscode.getState();
  if (['today', 'week', 'all'].includes(previous?.range)) byId('range').value = previous.range;
  for (const action of ['start', 'finish', 'cancel', 'select', 'export', 'clear', 'inspect']) {
    byId(action).addEventListener('click', () => vscode.postMessage({ action }));
  }
  byId('range').addEventListener('change', () => {
    vscode.setState({ range: byId('range').value });
    render();
  });
  function render() {
    if (!snapshot) return;
    const all = snapshot.records;
    const now = snapshot.now;
    const range = byId('range').value;
    const week = new Date(dayStart(now)); week.setDate(week.getDate() - 6);
    const since = range === 'today' ? dayStart(now) : range === 'week' ? week.getTime() : 0;
    const records = all.filter(r => r.startedAt >= since);
    const active = all.filter(r => r.status === 'running');
    const current = active.filter(r => r.model === snapshot.selectedModel);
    const manual = active.some(r => r.source === 'manual');
    text('lifetime-requests', number(snapshot.totals.requests));
    for (const [id, key] of [['input', 'inputTokens'], ['output', 'outputTokens']]) {
      const stat = snapshot.totals[key];
      text(`lifetime-${id}`, number(stat.known ? stat.value : null));
      text(`lifetime-${id}-coverage`, coverage(stat, snapshot.totals.requests));
    }
    text('model', snapshot.selectedModel || 'No model selected');
    text('model-source', snapshot.selectedModel ? ` / ${snapshot.selectionSource === 'manual' ? 'MANUAL SELECTION' : 'REPORTED SELECTION'}` : '');
    text('live-time', current.length ? duration(now - current[0].startedAt) : '—');
    const liveInput = sum(current, 'inputTokens');
    const liveOutput = sum(current, 'outputTokens');
    text('live-detail', current.length
      ? `${current.length} active · ${number(liveInput.value)} input / ${number(liveOutput.value)} output tokens${active.length > current.length ? ` · ${active.length - current.length} other model request(s) running` : ''}`
      : active.length ? `${active.length} request(s) running on other models` : 'No active requests');
    byId('start').hidden = manual;
    byId('finish').hidden = !manual;
    byId('cancel').hidden = !manual;
    if (snapshot.integrationSeen) {
      text('connection', 'Integration events received this session');
      text('connection-detail', 'Displaying events supplied through the extension API. Coverage below shows which requests include token data.');
    } else {
      text('connection', 'Automatic Antigravity integration pending');
      text('connection-detail', `${snapshot.targetInstalled ? 'gogle.google-antigravity is installed.' : 'gogle.google-antigravity is not detected in this window.'} Manual timers track duration; tokens require an adapter that reports usage.`);
    }
    text('requests', number(records.length));
    text('outcomes', `${records.filter(r => r.status === 'completed').length} completed · ${records.filter(r => r.status === 'failed').length} failed · ${records.filter(r => r.status === 'cancelled').length} cancelled · ${records.filter(r => r.status === 'interrupted').length} interrupted`);
    for (const [id, key] of [['input', 'inputTokens'], ['output', 'outputTokens']]) {
      const stat = sum(records, key);
      text(id, number(stat.value));
      text(`${id}-coverage`, coverage(stat, records.length));
    }
    text('average', duration(average(records)));
    const cost = sum(records, 'costUsd');
    text('cost', cost.value === null ? '—' : cost.value.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }));
    text('cost-coverage', coverage(cost, records.length));
    const days = [];
    for (let offset = 6; offset >= 0; offset--) {
      const date = new Date(dayStart(now)); date.setDate(date.getDate() - offset);
      days.push({ date, count: all.filter(r => dayStart(r.startedAt) === date.getTime()).length });
    }
    const max = Math.max(1, ...days.map(d => d.count));
    const chart = byId('chart'); chart.replaceChildren();
    for (const day of days) {
      const cell = element('div', undefined, 'day');
      const meter = element('meter');
      meter.min = 0; meter.max = max; meter.value = day.count;
      meter.setAttribute('aria-label', `${day.date.toLocaleDateString()}: ${day.count} requests`);
      cell.append(element('strong', number(day.count)), meter, element('span', day.date.toLocaleDateString(undefined, { weekday: 'short' })));
      chart.append(cell);
    }
    const models = byId('models'); models.replaceChildren();
    const groups = new Map();
    for (const record of records) groups.set(record.model, [...(groups.get(record.model) || []), record]);
    if (!groups.size) {
      const row = element('tr'); const cell = element('td', 'No model activity in this period.', 'muted'); cell.colSpan = 5; row.append(cell); models.append(row);
    }
    for (const [model, group] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const row = element('tr');
      row.append(element('td', model), element('td', number(group.length)));
      for (const key of ['inputTokens', 'outputTokens']) {
        const stat = sum(group, key);
        const cell = element('td', number(stat.value));
        cell.title = coverage(stat, group.length);
        if (stat.known > 0 && stat.known < group.length) cell.append(element('small', 'Partial'));
        row.append(cell);
      }
      row.append(element('td', duration(average(group)))); models.append(row);
    }
    byId('empty').hidden = records.length > 0;
    byId('history-table').hidden = !records.length;
    const history = byId('history'); history.replaceChildren();
    for (const r of records.slice(0, 100)) {
      const row = element('tr');
      const elapsed = r.status === 'running' ? now - r.startedAt : r.endedAt === undefined ? null : r.endedAt - r.startedAt;
      row.append(element('td', new Date(r.startedAt).toLocaleString()), element('td', r.model), element('td', duration(elapsed)),
        element('td', `${number(r.inputTokens)} / ${number(r.outputTokens)}`));
      const status = element('td'); status.append(element('span', r.status, `badge ${r.status}`));
      row.append(status, element('td', r.source)); history.append(row);
    }
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'snapshot' || !Array.isArray(event.data.records)) return;
    snapshot = event.data;
    render();
  });
  vscode.postMessage({ type: 'ready' });
})();
