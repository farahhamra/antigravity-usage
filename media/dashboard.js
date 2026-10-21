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
  const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  function localDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day, 12);
    return year >= 1000 && year <= 9999 && dateKey(date) === value ? date : undefined;
  }
  let calendarMonth = localDate(`${previous?.calendarMonth}-01`) ? previous.calendarMonth : undefined;
  let calendarCache;
  let selectedDay;
  const saveView = () => vscode.setState({ range: byId('range').value, calendarMonth });
  if (['today', 'week', 'all'].includes(previous?.range)) byId('range').value = previous.range;
  for (const action of ['start', 'finish', 'cancel', 'select', 'export', 'clear', 'inspect', 'subscription', 'refreshQuota']) {
    byId(action).addEventListener('click', () => vscode.postMessage({ action }));
  }
  byId('range').addEventListener('change', () => {
    saveView();
    render();
  });
  for (const [id, direction] of [['calendar-prev', -1], ['calendar-next', 1], ['calendar-today', 0]]) {
    byId(id).addEventListener('click', () => {
      if (!snapshot) return;
      const month = direction ? localDate(`${calendarMonth}-01`) : new Date(snapshot.now);
      if (direction) month.setMonth(month.getMonth() + direction);
      if (month.getFullYear() < 1000 || month.getFullYear() > 9999) return;
      calendarMonth = dateKey(month).slice(0, 7); selectedDay = undefined;
      saveView(); render();
    });
  }
  byId('subscription-marker').addEventListener('change', () => {
    vscode.postMessage({ action: 'subscriptionMode', value: byId('subscription-marker').value });
  });

  function renderQuotas() {
    const quota = snapshot.quota || { state: 'waiting', entries: [], refreshing: false };
    const updated = quota.updatedAt ? new Date(quota.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined;
    const stale = quota.state === 'stale' || (quota.updatedAt !== undefined && snapshot.now - quota.updatedAt > 90000);
    text('quota-status', stale ? `Last known limits${updated ? ` · updated ${updated}` : ''} · waiting for a fresh provider report`
      : quota.state === 'ready' ? `Updated ${updated}${quota.refreshing ? ' · refreshing…' : ''}`
      : quota.state === 'loading' ? 'Reading model limits…'
      : quota.state === 'unavailable' ? 'Antigravity has not provided model limits. Retrying automatically.'
      : 'Open Antigravity to see model limits.');
    byId('refreshQuota').disabled = quota.refreshing;
    const cards = byId('quotas'); cards.replaceChildren();
    for (const entry of quota.entries) {
      const card = element('article', undefined, `quota-card${stale ? ' stale' : ''}`);
      const heading = element('div', undefined, 'quota-title');
      heading.append(element('h3', entry.label), element('span', entry.scope === 'group' ? 'Shared limit' : 'Model', 'badge'));
      card.append(heading);
      if (entry.disabled) card.append(element('p', 'Model unavailable', 'muted'));
      for (const window of entry.windows) {
        const section = element('div', undefined, 'quota-window');
        const remaining = window.remainingFraction;
        const known = typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0 && remaining <= 1;
        const line = element('div', undefined, 'quota-line');
        line.append(element('span', window.label, 'muted'));
        if (known) {
          const remainingPercent = Math.round(remaining * 1000) / 10;
          const usedPercent = Math.round((1 - remaining) * 1000) / 10;
          line.append(element('strong', `${remainingPercent}% remaining`));
          const meter = element('meter', undefined, remaining === 0 ? 'exhausted' : remaining <= 0.1 ? 'low' : '');
          meter.min = 0; meter.max = 100; meter.value = usedPercent;
          meter.setAttribute('aria-label', `${entry.label}, ${window.label}: ${usedPercent}% used, ${remainingPercent}% remaining`);
          section.append(line, meter);
          section.append(element('small', `${usedPercent}% used${entry.disabled ? '' : remaining === 0 ? ' · Limit reached' : remaining <= 0.1 ? ' · Running low' : ' · Available'}`));
        } else { line.append(element('span', 'Quota not reported')); section.append(line); }
        if (window.resetAt !== undefined) {
          const until = window.resetAt - snapshot.now;
          const reset = element('small', until > 0 ? `Resets in ${duration(until)}` : 'Reset due · waiting for provider update');
          reset.title = `Provider reset: ${new Date(window.resetAt).toLocaleString()}`;
          section.append(reset);
        }
        card.append(section);
      }
      cards.append(card);
    }
  }

  function renderCalendar() {
    calendarMonth ??= dateKey(new Date(snapshot.now)).slice(0, 7);
    const month = localDate(`${calendarMonth}-01`);
    const year = month.getFullYear(); const index = month.getMonth();
    const dayCount = new Date(year, index + 1, 0).getDate();
    const today = dateKey(new Date(snapshot.now));
    const subscription = snapshot.subscription || {};
    const start = localDate(subscription.startDate);
    const monthly = subscription.marker !== 'startDate';
    const markerDay = start ? Math.min(start.getDate(), dayCount) : undefined;
    const monthRecords = snapshot.records.filter(r => dateKey(new Date(r.startedAt)).startsWith(`${calendarMonth}-`));
    const days = Array.from({ length: dayCount }, (_, i) => {
      const date = new Date(year, index, i + 1, 12); const key = dateKey(date);
      const records = monthRecords.filter(r => dateKey(new Date(r.startedAt)) === key);
      const marker = start && (key === subscription.startDate || (monthly && key >= subscription.startDate && i + 1 === markerDay));
      return { date, key, records, marker, input: sum(records, 'inputTokens'), output: sum(records, 'outputTokens') };
    });
    const cache = JSON.stringify([calendarMonth, today, subscription, selectedDay, days.map(day => [day.key, day.records.length, day.input, day.output, day.records.some(r => r.usagePartial)])]);
    if (cache === calendarCache) return;
    calendarCache = cache;
    const focused = document.activeElement?.dataset?.date;
    const title = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    text('calendar-month', title);
    byId('calendar-prev').disabled = year === 1000 && index === 0;
    byId('calendar-next').disabled = year === 9999 && index === 11;
    const chart = byId('chart'); chart.replaceChildren(); chart.setAttribute('aria-label', `${title} activity`);
    const offset = (month.getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) { const blank = element('span', undefined, 'calendar-blank'); blank.setAttribute('aria-hidden', 'true'); chart.append(blank); }
    const max = Math.max(1, ...days.map(day => day.records.length));
    const details = day => {
      const count = day.records.length;
      const partial = day.records.some(r => r.usagePartial) || day.input.known < count || day.output.known < count;
      return `${day.date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: ${number(count)} ${count === 1 ? 'request' : 'requests'}`
        + (count ? ` · ${number(day.input.value)} input / ${number(day.output.value)} output tokens${partial ? ' · partial token data' : ''}` : '')
        + (day.marker ? day.key === subscription.startDate ? ' · Subscription started' : ' · Subscription day' : '');
    };
    for (const day of days) {
      const level = day.records.length ? Math.ceil(day.records.length / max * 4) : 0;
      const cell = element('button', undefined, `calendar-day heat-${level}${day.key === today ? ' today' : ''}${day.marker ? ' subscription-day' : ''}${day.key > today ? ' future' : ''}`);
      cell.dataset.date = day.key; cell.dataset.count = String(day.records.length);
      cell.setAttribute('aria-label', details(day)); cell.title = details(day);
      cell.setAttribute('aria-pressed', String(selectedDay === day.key));
      if (day.key === today) cell.setAttribute('aria-current', 'date');
      cell.append(element('span', String(day.date.getDate()), 'calendar-day-number'));
      if (day.marker) { const marker = element('span', '◆', 'subscription-symbol'); marker.setAttribute('aria-hidden', 'true'); cell.append(marker); }
      cell.addEventListener('click', () => { selectedDay = day.key; renderCalendar(); });
      chart.append(cell);
    }
    const selected = days.find(day => day.key === selectedDay);
    text('activity-detail', selected ? details(selected) : `${number(monthRecords.length)} requests in ${title}. Select a day for details.`);
    text('subscription', start ? `Subscription · ${start.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : 'Add subscription date');
    byId('subscription-marker').value = monthly ? 'monthly' : 'startDate';
    text('subscription-note', start ? monthly ? '◆ Subscription day each month; shorter months use their last day.' : '◆ Original subscription start date.' : 'Add your start date to mark it on the calendar.');
    if (focused) chart.querySelector(`[data-date="${focused}"]`)?.focus({ preventScroll: true });
  }
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
      text(`lifetime-${id}-coverage`, coverage(stat, snapshot.totals.requests) + (snapshot.totals.partialRequests ? ' · some request data incomplete' : ''));
    }
    text('model', snapshot.selectedModel || 'No model reported');
    text('model-source', snapshot.selectedModel ? ` / ${snapshot.selectionSource === 'manual' ? 'MANUAL SELECTION' : 'REPORTED MODEL'}` : '');
    text('live-time', current.length ? duration(now - current[0].startedAt) : '—');
    const liveInput = sum(current, 'inputTokens');
    const liveOutput = sum(current, 'outputTokens');
    text('live-detail', current.length
      ? `${current.length} active · ${number(liveInput.value)} input / ${number(liveOutput.value)} output tokens${active.length > current.length ? ` · ${active.length - current.length} other model request(s) running` : ''}`
      : active.length ? `${active.length} request(s) running on other models` : 'No active requests');
    byId('start').hidden = manual;
    byId('finish').hidden = !manual;
    byId('cancel').hidden = !manual;
    if (snapshot.liveStatus) {
      const { state, usage } = snapshot.liveStatus;
      const messages = {
        missing: ['Google Antigravity not detected', 'Install Google.google-antigravity in this extension host, then open it and send a new request.'],
        waiting: ['Waiting for Antigravity', 'Open Google Antigravity and send a new request. Automatic tracking starts when its local backend is ready.'],
        unsupported: ['Antigravity connection unavailable', 'The active extension has not exported a usable local connection. It may still be starting; use Inspect for its version and status.'],
        connecting: ['Connecting to Antigravity', 'Opening the local activity stream.'],
        connected: ['Live Antigravity activity connected', usage === 'unavailable'
          ? 'Request timing is connected, but token metadata could not be read. Retrying automatically; existing counts are preserved.'
          : 'New requests are tracked automatically. Tokens update as Antigravity reports model-call usage, usually after a model call finishes. Separate subagent usage and idle model-picker changes are not included.'],
        retrying: ['Antigravity disconnected · retrying', 'Unfinished timers are marked interrupted until newer activity confirms they resumed.'],
        paused: ['Automatic tracking paused', 'Local history could not be read or saved. Inspect the output, export history if needed, then reload the window.'],
      };
      const message = messages[state] || messages.waiting;
      text('connection', message[0]); text('connection-detail', message[1]);
    } else if (snapshot.integrationSeen) {
      text('connection', 'Integration events received this session');
      text('connection-detail', 'Displaying events supplied through the extension API. Coverage below shows which requests include token data.');
    } else {
      text('connection', 'Waiting for Antigravity');
      text('connection-detail', 'Open Google.google-antigravity and send a new request. Manual timers are also available.');
    }
    text('requests', number(records.length));
    text('outcomes', `${records.filter(r => r.status === 'completed').length} completed · ${records.filter(r => r.status === 'failed').length} failed · ${records.filter(r => r.status === 'cancelled').length} cancelled · ${records.filter(r => r.status === 'interrupted').length} interrupted`);
    for (const [id, key] of [['input', 'inputTokens'], ['output', 'outputTokens']]) {
      const stat = sum(records, key);
      text(id, number(stat.value));
      text(`${id}-coverage`, coverage(stat, records.length) + (records.some(r => r.usagePartial) ? ' · some request data incomplete' : ''));
    }
    text('average', duration(average(records)));
    const cost = sum(records, 'costUsd');
    text('cost', cost.value === null ? '—' : cost.value.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }));
    text('cost-coverage', coverage(cost, records.length));
    renderQuotas(); renderCalendar();
    const models = byId('models'); models.replaceChildren();
    const groups = new Map();
    for (const record of records) {
      const models = record.modelUsage?.length ? record.modelUsage : [{ model: record.model, inputTokens: record.inputTokens, outputTokens: record.outputTokens }];
      for (const usage of models) groups.set(usage.model, [...(groups.get(usage.model) || []), {
        ...record, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      }]);
    }
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
        if ((stat.known > 0 && stat.known < group.length) || group.some(r => r.usagePartial)) cell.append(element('small', 'Partial'));
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
      const tokens = element('td', `${number(r.inputTokens)} / ${number(r.outputTokens)}`);
      if (r.usagePartial) tokens.append(element('small', 'Partial / awaiting data'));
      row.append(element('td', new Date(r.startedAt).toLocaleString()), element('td', r.modelUsage?.length > 1 ? r.modelUsage.map(m => m.model).join(' + ') : r.model), element('td', duration(elapsed)), tokens);
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
