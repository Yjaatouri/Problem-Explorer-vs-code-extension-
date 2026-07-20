import * as vscode from 'vscode';
import { TelemetryBus, getTelemetryBus } from '../../telemetry/TelemetryBus';
import { TelemetryEvent } from '../../telemetry/TelemetryEvent';

const MAX_HISTORY = 10000;
const MAX_DISPLAY_EVENTS = 500;
const MAX_STORE_SAMPLES = 200;

/* ------------------------------------------------------------------ */
/*  Message protocol types                                             */
/* ------------------------------------------------------------------ */

interface DashboardFilter {
  traceId: string;
  provider: string;
  eventType: string;
}

type DashboardMessage =
  | { readonly type: 'event'; readonly event: TelemetryEvent }
  | { readonly type: 'eventBatch'; readonly events: readonly TelemetryEvent[] }
  | { readonly type: 'filter'; readonly filter: DashboardFilter }
  | { readonly type: 'requestTimeline'; readonly traceId: string }
  | { readonly type: 'timeline'; readonly traceId: string; readonly events: readonly TelemetryEvent[] }
  | { readonly type: 'requestSnapshot' }
  | { readonly type: 'snapshot'; readonly data: string }
  | { readonly type: 'requestPerformance' }
  | { readonly type: 'performance'; readonly stats: Record<string, number[]> }
  | { readonly type: 'requestHistory' }
  | { readonly type: 'clear' };

/* ------------------------------------------------------------------ */
/*  DeveloperDashboard                                                 */
/* ------------------------------------------------------------------ */

export class DeveloperDashboard {
  private panel: vscode.WebviewPanel | undefined;
  private readonly bus: TelemetryBus;
  private readonly eventHistory: TelemetryEvent[] = [];
  private readonly filter: DashboardFilter = { traceId: '', provider: '', eventType: '' };
  private readonly busSub: import('../../telemetry/TelemetryBus').TelemetrySubscription;
  private disposed = false;

  constructor() {
    this.bus = getTelemetryBus();

    /* Subscribe to all events via the bus (read from TelemetryBus, no logic duplication) */
    this.busSub = this.bus.subscribeAll((event: TelemetryEvent) => {
      if (this.disposed) return;

      this.eventHistory.push(event);
      if (this.eventHistory.length > MAX_HISTORY) {
        this.eventHistory.splice(0, this.eventHistory.length - MAX_HISTORY);
      }

      if (this.panel && this.matchesFilter(event, this.filter)) {
        this.postMessage({ type: 'event', event });
      }
    });
  }

  /** Show or reveal the developer dashboard webview panel */
  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'problemExplorerDeveloperDashboard',
      'Developer Dashboard',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage((msg: DashboardMessage) => {
      this.handleMessage(msg);
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    /* Send initial batch of matching events */
    const batch = this.getFilteredEvents(this.filter).slice(-MAX_DISPLAY_EVENTS);
    this.postMessage({ type: 'eventBatch', events: batch });
  }

  /* ------------------------------------------------------------------ */
  /*  Message handling                                                   */
  /* ------------------------------------------------------------------ */

  private handleMessage(msg: DashboardMessage): void {
    switch (msg.type) {
      case 'filter':
        this.filter.traceId = msg.filter.traceId;
        this.filter.provider = msg.filter.provider;
        this.filter.eventType = msg.filter.eventType;
        const batch = this.getFilteredEvents(this.filter).slice(-MAX_DISPLAY_EVENTS);
        this.postMessage({ type: 'eventBatch', events: batch });
        break;

      case 'requestTimeline': {
        const traceEvents = this.eventHistory
          .filter((e) => e.traceId === msg.traceId)
          .sort((a, b) => a.timestamp - b.timestamp);
        this.postMessage({ type: 'timeline', traceId: msg.traceId, events: traceEvents });
        break;
      }

      case 'requestSnapshot': {
        const snapshotData = this.captureSnapshotData();
        this.postMessage({ type: 'snapshot', data: snapshotData });
        break;
      }

      case 'requestPerformance': {
        const stats = this.computePerformanceStats();
        this.postMessage({ type: 'performance', stats });
        break;
      }

      case 'requestHistory': {
        const batch = this.getFilteredEvents(this.filter).slice(-MAX_DISPLAY_EVENTS);
        this.postMessage({ type: 'eventBatch', events: batch });
        break;
      }

      case 'clear':
        this.eventHistory.length = 0;
        this.postMessage({ type: 'eventBatch', events: [] });
        break;
    }
  }

  private postMessage(msg: DashboardMessage): void {
    if (this.panel) {
      this.panel.webview.postMessage(msg);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Filtering                                                          */
  /* ------------------------------------------------------------------ */

  private matchesFilter(event: TelemetryEvent, filter: DashboardFilter): boolean {
    if (filter.traceId && !event.traceId.includes(filter.traceId)) return false;
    if (filter.provider && event.source && !event.source.includes(filter.provider)) return false;
    if (filter.eventType && !event.type.includes(filter.eventType)) return false;
    return true;
  }

  private getFilteredEvents(filter: DashboardFilter): TelemetryEvent[] {
    if (!filter.traceId && !filter.provider && !filter.eventType) {
      return [...this.eventHistory];
    }
    return this.eventHistory.filter((e) => this.matchesFilter(e, filter));
  }

  /* ------------------------------------------------------------------ */
  /*  Performance statistics                                             */
  /* ------------------------------------------------------------------ */

  private computePerformanceStats(): Record<string, number[]> {
    const groups: Record<string, number[]> = {};
    for (const event of this.eventHistory) {
      if (!event.type.startsWith('perf.') && !event.type.startsWith('timer.')) continue;
      const data = event as any;
      const duration = data.executionTimeMs ?? data.durationMs ?? data.actualDelay ?? 0;
      if (typeof duration === 'number' && duration > 0) {
        const key = event.type;
        if (!groups[key]) groups[key] = [];
        groups[key].push(duration);
        if (groups[key].length > MAX_STORE_SAMPLES) groups[key].shift();
      }
    }
    return groups;
  }

  /* ------------------------------------------------------------------ */
  /*  Snapshot capture                                                   */
  /* ------------------------------------------------------------------ */

  private captureSnapshotData(): string {
    const lines: string[] = [];
    lines.push(`System Snapshot — ${new Date().toISOString()}`);
    lines.push(`Total events recorded: ${this.eventHistory.length}`);
    lines.push(`Active event types: ${new Set(this.eventHistory.map((e) => e.type)).size}`);
    lines.push(``);
    lines.push(`Event type breakdown:`);
    const counts: Record<string, number> = {};
    for (const e of this.eventHistory) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    }
    for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${type}: ${count}`);
    }
    lines.push(``);
    lines.push(`Unique TraceIds: ${new Set(this.eventHistory.map((e) => e.traceId)).size}`);
    lines.push(`Unique sources: ${new Set(this.eventHistory.filter((e) => e.source).map((e) => e.source as string)).size}`);
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Webview HTML                                                       */
  /* ------------------------------------------------------------------ */

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
  font-size: 13px;
  color: var(--vscode-editor-foreground, #d4d4d4);
  background: var(--vscode-editor-background, #1e1e1e);
  padding: 8px;
  overflow-x: hidden;
}
.toolbar {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, #333);
  margin-bottom: 8px;
}
.toolbar label { font-size: 11px; opacity: 0.7; min-width: 40px; }
.toolbar input {
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #555);
  padding: 2px 6px; font-size: 12px; width: 140px; font-family: inherit;
}
.toolbar input::placeholder { opacity: 0.4; }
.toolbar button {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none; padding: 3px 10px; cursor: pointer; font-size: 12px;
}
.toolbar button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.toolbar .stats {
  font-size: 11px; opacity: 0.6; margin-left: auto;
}
.tabs {
  display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border, #333);
  margin-bottom: 8px;
}
.tab {
  padding: 4px 14px; cursor: pointer; font-size: 12px;
  border: 1px solid transparent; border-bottom: none;
  opacity: 0.7; user-select: none;
}
.tab:hover { opacity: 1; }
.tab.active {
  opacity: 1; border-color: var(--vscode-panel-border, #333);
  background: var(--vscode-tab-activeBackground, #2d2d2d);
}
.tab-content { display: none; }
.tab-content.active { display: block; }

/* Event feed */
#eventList {
  max-height: 60vh; overflow-y: auto;
  border: 1px solid var(--vscode-panel-border, #333);
  padding: 4px;
}
.event {
  padding: 2px 4px; font-size: 11px; line-height: 1.4;
  border-bottom: 1px solid var(--vscode-panel-border, #333);
  cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.event:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.event .time { opacity: 0.5; margin-right: 8px; }
.event .type { font-weight: bold; margin-right: 8px; }
.event .src { opacity: 0.6; margin-right: 8px; }
.event .tid { opacity: 0.4; font-size: 10px; }
.event.err { border-left: 3px solid #f48771; background: rgba(244,135,113,0.08); }
.event.warn { border-left: 3px solid #cca700; background: rgba(204,167,0,0.08); }
.event.scan { border-left: 3px solid #6bc46d; }
.event.store { border-left: 3px solid #56b6c2; }
.event.decoration { border-left: 3px solid #c678dd; }
.event.folder { border-left: 3px solid #e5c07b; }
.event.timer { border-left: 3px solid #61afef; }
.event.pipeline { border-left: 3px solid #abb2bf; }
.event.perf { border-left: 3px solid #98c379; }
.event.assertion { border-left: 3px solid #f44747; }

/* Timeline */
.timeline-entry { padding: 2px 4px; font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border, #333); }
.timeline-entry .seq { opacity: 0.4; margin-right: 6px; }
.timeline-entry .dur { opacity: 0.5; margin-left: 8px; }
.timeline-entry .phase { opacity: 0.6; margin-left: 8px; font-style: italic; }

/* Performance */
.perf-group { margin-bottom: 6px; }
.perf-group .name { font-weight: bold; font-size: 12px; }
.perf-group .vals { font-size: 11px; opacity: 0.8; }

/* Errors */
.error-item { padding: 3px 4px; font-size: 11px; color: #f48771; border-bottom: 1px solid var(--vscode-panel-border, #333); }

/* Snapshot */
#snapshotContent { font-size: 11px; white-space: pre-wrap; line-height: 1.5; }

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #424242); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, #4f4f4f); }
</style>
</head>
<body>

<div class="toolbar">
  <label>TraceId</label>
  <input id="filterTraceId" placeholder="partial match" />
  <label>Provider</label>
  <input id="filterProvider" placeholder="source name" />
  <label>Type</label>
  <input id="filterType" placeholder="event type" />
  <button id="applyFilter">Apply</button>
  <button id="clearFilter">Clear</button>
  <button id="clearHistory">Clear Events</button>
  <span class="stats" id="statsBar">0 events</span>
</div>

<div class="tabs">
  <div class="tab active" data-tab="feed">Live Feed</div>
  <div class="tab" data-tab="timeline">Timeline</div>
  <div class="tab" data-tab="perf">Performance</div>
  <div class="tab" data-tab="errors">Errors</div>
  <div class="tab" data-tab="snapshot">Snapshot</div>
</div>

<div id="tab-feed" class="tab-content active">
  <div id="eventList"></div>
</div>

<div id="tab-timeline" class="tab-content">
  <div style="margin-bottom:4px;">
    <input id="timelineTraceId" placeholder="paste TraceId" style="width:300px;" />
    <button id="loadTimeline">Load Timeline</button>
  </div>
  <div id="timelineContent">Select a TraceId to view its timeline.</div>
</div>

<div id="tab-perf" class="tab-content">
  <div id="perfContent">Click "Refresh Stats" to compute.</div>
  <button id="refreshPerf" style="margin-top:4px;">Refresh Stats</button>
</div>

<div id="tab-errors" class="tab-content">
  <div id="errorList"></div>
</div>

<div id="tab-snapshot" class="tab-content">
  <button id="refreshSnapshot">Capture Snapshot</button>
  <pre id="snapshotContent">Click "Capture Snapshot" to take one.</pre>
</div>

<script>
(function () {
  const vscode = acquireVsCodeApi();
  let filter = { traceId: '', provider: '', eventType: '' };
  let eventCount = 0;

  const $ = (id) => document.getElementById(id);

  /* Render an event row */
  function renderEvent(e) {
    const div = document.createElement('div');
    div.className = 'event';
    if (e.type === 'assertion.failure' || (e.data && e.data.phase === 'error')) div.classList.add('err');
    else if (e.type.startsWith('provider.scan')) div.classList.add('scan');
    else if (e.type.startsWith('store.')) div.classList.add('store');
    else if (e.type.startsWith('decoration.')) div.classList.add('decoration');
    else if (e.type.startsWith('folder.')) div.classList.add('folder');
    else if (e.type.startsWith('timer.')) div.classList.add('timer');
    else if (e.type.startsWith('pipeline.')) div.classList.add('pipeline');
    else if (e.type.startsWith('perf.')) div.classList.add('perf');
    else if (e.type.startsWith('assertion.')) div.classList.add('assertion');

    const time = new Date(e.timestamp).toISOString().slice(11, 23);
    const src = e.source || '';
    const tid = e.traceId ? e.traceId.slice(0, 16) : '';

    div.innerHTML = '<span class="time">' + time + '</span>'
      + '<span class="type">' + escapeHtml(e.type) + '</span>'
      + (src ? '<span class="src">' + escapeHtml(src) + '</span>' : '')
      + '<span class="tid">' + escapeHtml(tid) + '</span>';

    div.title = JSON.stringify(e, null, 2);
    div.addEventListener('click', function () {
      $('timelineTraceId').value = e.traceId;
      loadTimeline(e.traceId);
    });
    return div;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (m) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; }); }

  /* Live feed */
  function appendEvent(e) {
    const list = $('eventList');
    list.appendChild(renderEvent(e));
    if (list.children.length > 500) list.removeChild(list.firstChild);
    eventCount++;
    updateStats();
  }

  function setEvents(events) {
    const list = $('eventList');
    list.innerHTML = '';
    for (const e of events) list.appendChild(renderEvent(e));
    eventCount = events.length;
    updateStats();
  }

  function updateStats() {
    $('statsBar').textContent = eventCount + ' events shown';
  }

  /* Timeline */
  function loadTimeline(traceId) {
    if (!traceId) return;
    vscode.postMessage({ type: 'requestTimeline', traceId });
  }

  function renderTimeline(events) {
    const el = $('timelineContent');
    if (!events || events.length === 0) {
      el.innerHTML = '(no events for this TraceId)';
      return;
    }
    const sorted = events.slice().sort(function (a, b) { return a.timestamp - b.timestamp; });
    const total = sorted.length >= 2 ? sorted[sorted.length - 1].timestamp - sorted[0].timestamp : 0;
    var html = '<div style="margin-bottom:4px;opacity:0.6;">' + events.length + ' events, total ' + total + 'ms</div>';
    for (var i = 0; i < sorted.length; i++) {
      var cur = sorted[i];
      var next = sorted[i + 1];
      var dur = next ? (next.timestamp - cur.timestamp) + 'ms' : '-';
      var time = new Date(cur.timestamp).toISOString().slice(11, 23);
      var data = cur;
      var phase = data.phase ? ' [' + data.phase + ']' : '';
      html += '<div class="timeline-entry">'
        + '<span class="seq">#' + (i + 1) + '</span>'
        + '<span class="time">' + time + '</span>'
        + '<strong>' + escapeHtml(cur.type) + '</strong>'
        + phase
        + '<span class="dur">+' + dur + '</span>'
        + '</div>';
    }
    el.innerHTML = html;
  }

  /* Performance */
  function renderPerf(stats) {
    var el = $('perfContent');
    var keys = Object.keys(stats);
    if (keys.length === 0) { el.innerHTML = '(no performance data collected)'; return; }
    var html = '';
    for (var k of keys) {
      var vals = stats[k];
      var sum = vals.reduce(function (a, b) { return a + b; }, 0);
      var avg = (sum / vals.length).toFixed(1);
      var min = Math.min.apply(null, vals).toFixed(1);
      var max = Math.max.apply(null, vals).toFixed(1);
      html += '<div class="perf-group"><span class="name">' + escapeHtml(k) + '</span>'
        + '<span class="vals">  count=' + vals.length + '  avg=' + avg + 'ms  min=' + min + 'ms  max=' + max + 'ms</span></div>';
    }
    el.innerHTML = html;
  }

  /* Errors */
  function renderErrors(events) {
    var el = $('errorList');
    var errs = events.filter(function (e) {
      return e.type === 'assertion.failure' || (e.phase === 'error') || (e.phase === 'cancelled');
    });
    if (errs.length === 0) { el.innerHTML = '(no errors recorded)'; return; }
    var html = '';
    for (var e of errs) {
      var time = new Date(e.timestamp).toISOString().slice(11, 23);
      html += '<div class="error-item">' + time + '  ' + escapeHtml(e.type) + '  ' + (e.detail || e.error || e.message || '') + '</div>';
    }
    el.innerHTML = html;
  }

  /* Focus a specific tab by name */
  function focusTab(name) {
    var tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.click();
  }

  /* Incoming messages */
  window.addEventListener('message', function (msg) {
    var m = msg.data;
    switch (m.type) {
      case 'event':
        appendEvent(m.event);
        break;
      case 'eventBatch':
        setEvents(m.events);
        break;
      case 'timeline':
        renderTimeline(m.events);
        break;
      case 'performance':
        renderPerf(m.stats);
        break;
      case 'snapshot':
        $('snapshotContent').textContent = m.data;
        break;
      case 'focusTab':
        focusTab(m.tab);
        break;
    }
  });

  /* Tab switching */
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      tab.classList.add('active');
      var id = 'tab-' + tab.getAttribute('data-tab');
      document.getElementById(id).classList.add('active');

      /* Refresh on tab switch */
      if (tab.getAttribute('data-tab') === 'perf') {
        vscode.postMessage({ type: 'requestPerformance' });
      } else if (tab.getAttribute('data-tab') === 'errors') {
        vscode.postMessage({ type: 'requestHistory' });
      }
    });
  });

  /* Toolbar actions */
  $('applyFilter').addEventListener('click', function () {
    filter = {
      traceId: $('filterTraceId').value,
      provider: $('filterProvider').value,
      eventType: $('filterType').value,
    };
    vscode.postMessage({ type: 'filter', filter: filter });
  });

  $('clearFilter').addEventListener('click', function () {
    $('filterTraceId').value = '';
    $('filterProvider').value = '';
    $('filterType').value = '';
    filter = { traceId: '', provider: '', eventType: '' };
    vscode.postMessage({ type: 'filter', filter: filter });
  });

  $('clearHistory').addEventListener('click', function () {
    vscode.postMessage({ type: 'clear' });
  });

  $('loadTimeline').addEventListener('click', function () {
    loadTimeline($('timelineTraceId').value);
  });

  $('refreshPerf').addEventListener('click', function () {
    vscode.postMessage({ type: 'requestPerformance' });
  });

  $('refreshSnapshot').addEventListener('click', function () {
    vscode.postMessage({ type: 'requestSnapshot' });
  });

  /* Keyboard shortcut: Enter in timeline input */
  $('timelineTraceId').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') loadTimeline(this.value);
  });
})();
</script>
</body>
</html>`;
  }

  /** Notify the dashboard of an assertion failure — reveals panel and focuses the Errors tab */
  notifyAssertion(): void {
    this.show();
    this.postMessage({ type: 'focusTab', tab: 'errors' } as any);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.busSub.dispose();
    if (this.panel) {
      this.panel.dispose();
      this.panel = undefined;
    }
  }
}