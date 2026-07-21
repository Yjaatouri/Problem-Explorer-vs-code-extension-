import * as vscode from 'vscode';
import type { DashboardViewApi, DashboardMessage } from './DashboardTypes';

/* ------------------------------------------------------------------ */
/*  DashboardView — VS Code Webview Panel                              */
/* ------------------------------------------------------------------ */

export class DashboardView implements DashboardViewApi {
  private panel: vscode.WebviewPanel | undefined;
  private messageHandler: ((message: DashboardMessage) => void) | undefined;
  private _disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
  ) {}

  get disposed(): boolean {
    return this._disposed;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'problemExplorerDashboard',
      'Problem Explorer Dashboard',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      (msg: DashboardMessage) => this.messageHandler?.(msg),
    );

    this.panel.onDidDispose(() => {
      this._disposed = true;
      this.panel = undefined;
    });
  }

  postMessage(message: DashboardMessage): void {
    this.panel?.webview.postMessage(message);
  }

  setMessageHandler(handler: (message: DashboardMessage) => void): void {
    this.messageHandler = handler;
  }

  dispose(): void {
    this._disposed = true;
    this.panel?.dispose();
    this.panel = undefined;
    this.messageHandler = undefined;
  }

  /* ------------------------------------------------------------------ */
  /*  HTML Template                                                      */
  /* ------------------------------------------------------------------ */

  private getHtml(): string {
    return /* html */`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ccc);
      font-size: 13px;
      line-height: 1.5;
      overflow: hidden;
      height: 100vh;
    }
    #app { display: flex; flex-direction: column; height: 100vh; }
    .header { display:flex; align-items:center; padding:8px 16px; background:var(--vscode-titleBar-activeBackground,#323233); border-bottom:1px solid var(--vscode-panel-border,#3c3c3c); flex-shrink:0; }
    .header h1 { font-size:16px; font-weight:600; flex:1; }
    .header .badge { font-size:11px; background:var(--vscode-badge-background,#4d4d4d); color:var(--vscode-badge-foreground,#fff); padding:2px 8px; border-radius:10px; margin-left:8px; }
    .layout { display:flex; flex:1; overflow:hidden; }
    .sidebar { width:180px; background:var(--vscode-sideBar-background,#252526); border-right:1px solid var(--vscode-panel-border,#3c3c3c); overflow-y:auto; flex-shrink:0; }
    .nav-item { display:flex; align-items:center; padding:8px 12px; cursor:pointer; border-left:3px solid transparent; transition:background 0.15s; }
    .nav-item:hover { background:var(--vscode-list-hoverBackground,#2a2d2e); }
    .nav-item.active { background:var(--vscode-list-activeSelectionBackground,#094771); color:var(--vscode-list-activeSelectionForeground,#fff); border-left-color:var(--vscode-focusBorder,#007fd4); }
    .nav-item .icon { width:20px; text-align:center; margin-right:8px; }
    .content { flex:1; overflow-y:auto; padding:16px; }
    .status-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
    .status-dot.green { background:#4ec9b0; }
    .status-dot.yellow { background:#dcdcaa; }
    .status-dot.red { background:#f44747; }
    .status-dot.gray { background:#6a6a6a; }
    .stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; margin-bottom:16px; }
    .stat-card { background:var(--vscode-editorWidget-background,#252526); border:1px solid var(--vscode-widget-border,#3c3c3c); border-radius:6px; padding:12px; }
    .stat-card .label { font-size:11px; text-transform:uppercase; color:var(--vscode-descriptionForeground,#8c8c8c); margin-bottom:4px; }
    .stat-card .value { font-size:22px; font-weight:600; }
    .stat-card .sub { font-size:11px; color:var(--vscode-descriptionForeground,#8c8c8c); margin-top:2px; }
    .section { margin-bottom:20px; }
    .section h3 { font-size:14px; font-weight:600; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid var(--vscode-panel-border,#3c3c3c); }
    table { width:100%; border-collapse:collapse; margin-bottom:16px; }
    th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border,#3c3c3c); }
    th { font-size:11px; text-transform:uppercase; color:var(--vscode-descriptionForeground,#8c8c8c); position:sticky; top:0; background:var(--vscode-editor-background,#1e1e1e); }
    tr:hover { background:var(--vscode-list-hoverBackground,#2a2d2e); }
    .spinner { display:inline-block; width:16px; height:16px; border:2px solid var(--vscode-editor-foreground,#ccc); border-top-color:transparent; border-radius:50%; animation:spin 0.8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .loading-overlay { display:flex; align-items:center; justify-content:center; padding:40px; gap:8px; }
    .error-banner { background:var(--vscode-inputValidation-errorBackground,#5a1d1d); color:var(--vscode-inputValidation-errorForeground,#f48771); border:1px solid var(--vscode-inputValidation-errorBorder,#be1100); border-radius:4px; padding:8px 12px; margin-bottom:12px; }
    .empty-state { text-align:center; padding:32px; color:var(--vscode-descriptionForeground,#8c8c8c); }
    .search-bar { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
    .search-bar input,.search-bar select { background:var(--vscode-input-background,#3c3c3c); color:var(--vscode-input-foreground,#ccc); border:1px solid var(--vscode-input-border,#3c3c3c); padding:4px 8px; border-radius:3px; font-size:12px; }
    .search-bar input { flex:1; min-width:150px; }
    .search-bar input:focus,.search-bar select:focus { outline:none; border-color:var(--vscode-focusBorder,#007fd4); }
    .detail-row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--vscode-panel-border,#3c3c3c); }
    .detail-label { color:var(--vscode-descriptionForeground,#8c8c8c); }
    .detail-value { font-weight:500; }
    ::-webkit-scrollbar { width:8px; }
    ::-webkit-scrollbar-track { background:transparent; }
    ::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background,#424242); border-radius:4px; }
    ::-webkit-scrollbar-thumb:hover { background:var(--vscode-scrollbarSlider-hoverBackground,#555); }
  </style>
</head>
<body>
<div id="app">
  <div class="header">
    <h1>Problem Explorer Dashboard</h1>
    <span class="badge" id="healthBadge">--</span>
    <span style="margin-left:8px;font-size:11px;color:var(--vscode-descriptionForeground)" id="refreshStatus"></span>
  </div>
  <div class="layout">
    <nav class="sidebar" id="sidebar"></nav>
    <main class="content" id="content">
      <div class="loading-overlay"><span class="spinner"></span> Loading dashboard...</div>
    </main>
  </div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  let state = { currentPanel: 'overview', data: {}, loading: {}, error: undefined, filter: {} };

  const panels = [
    { id:'overview', label:'Overview', icon:'\\u25A3' },
    { id:'store', label:'Store', icon:'\\u2261' },
    { id:'provider', label:'Providers', icon:'\\u2699' },
    { id:'autoscanner', label:'AutoScanner', icon:'\\u25B6' },
    { id:'diagnostics', label:'Diagnostics', icon:'\\u2697' },
    { id:'folder', label:'Folder', icon:'\\u25A1' },
    { id:'decoration', label:'Decoration', icon:'\\u270E' },
    { id:'pipeline', label:'Pipeline', icon:'\\u2388' },
    { id:'assertions', label:'Assertions', icon:'\\u2713' },
    { id:'snapshots', label:'Snapshots', icon:'\\u231A' },
    { id:'timeline', label:'Timeline', icon:'\\u29D6' },
    { id:'filelogger', label:'File Logger', icon:'\\u266B' },
    { id:'performance', label:'Performance', icon:'\\u26A1' },
    { id:'export', label:'Export', icon:'\\u2B07' },
  ];

  const sidebar = document.getElementById('sidebar');
  const content = document.getElementById('content');
  const healthBadge = document.getElementById('healthBadge');

  /* ---- Navigation ---- */
  function renderNav() {
    sidebar.innerHTML = panels.map(p => \`<div class="nav-item \${state.currentPanel === p.id ? 'active' : ''}" data-panel="\${p.id}"><span class="icon">\${p.icon}</span><span>\${p.label}</span></div>\`).join('');
    sidebar.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', () => {
        state.currentPanel = el.dataset.panel;
        renderNav();
        vscode.postMessage({ type: 'navigate', panel: el.dataset.panel });
      });
    });
  }

  /* ---- Panel Renderers ---- */
  function renderPanel(panelId, data) {
    if (!data) return '<div class=\"loading-overlay\"><span class=\"spinner\"></span> Loading...</div>';
    if (data.error) return \`<div class="error-banner">\\u26A0 \${data.error}</div>\`;
    var fns = {
      overview: renderOverview, store: renderStore, provider: renderProvider,
      autoscanner: renderAutoScanner, diagnostics: renderDiagnostics, folder: renderFolder,
      decoration: renderDecoration, pipeline: renderPipeline, assertions: renderAssertions,
      snapshots: renderSnapshots, timeline: renderTimeline, filelogger: renderFileLogger,
      performance: renderPerformance, export: renderExport,
    };
    return (fns[panelId] || function(){ return '<div class=\"empty-state\">Unknown panel</div>'; })(data);
  }

  /* ---- Overview ---- */
  function renderOverview(d) {
    return '<div class=\"stat-grid\">' +
      statCard('Health Score', d.healthScore ?? '--', 'Level: ' + (d.healthLevel ?? '--'), getHealthColor(d.healthScore)) +
      statCard('Memory', (d.memoryMb ?? 0) + ' MB', 'heap usage') +
      statCard('Active Providers', d.activeProviders ?? 0) +
      statCard('Active Scans', d.activeScans ?? 0) +
      statCard('Active Pipelines', d.activePipelines ?? 0) +
      statCard('Snapshots', d.snapshotCount ?? 0) +
      statCard('Assertion Failures', d.assertionFailures ?? 0) +
      statCard('Events Processed', (d.totalEventsProcessed ?? 0).toLocaleString()) +
      statCard('Uptime', formatUptime(d.uptimeSec)) +
    '</div>' +
    '<div class=\"section\"><h3>Environment</h3>' +
    detail('Extension', d.extensionVersion || '--') +
    detail('VS Code', d.vscodeVersion || '--') +
    '</div>';
  }

  /* ---- Store ---- */
  function renderStore(d) {
    return '<div class=\"section\"><h3>ProblemStore Snapshot</h3>' +
      detail('Provider Configurations', (d.providers && d.providers.length) || 0) +
      detail('Owner Configurations', (d.ownerConfig && d.ownerConfig.size) || 0) +
      '</div><pre style=\"font-size:11px;background:var(--vscode-editorWidget-background);padding:8px;border-radius:4px;overflow:auto;max-height:400px\">' +
      safeJson(d) + '</pre>';
  }

  /* ---- Provider ---- */
  function renderProvider(d) {
    var stats = d.statistics || [];
    var snaps = d.snapshots || [];
    var html = '<div class=\"section\"><h3>Provider Statistics (' + stats.length + ')</h3>';
    if (stats.length === 0) html += '<div class=\"empty-state\">No provider statistics</div>';
    else {
      html += '<table><tr><th>Provider</th><th>Scans</th><th>Failures</th><th>Timeouts</th><th>Scan Avg</th><th>Refresh Avg</th></tr>';
      for (var i = 0; i < stats.length; i++) {
        var s = stats[i];
        html += '<tr><td>' + esc(s.name) + '</td><td>' + (s.scanCount || 0) + '</td><td>' + (s.failures || 0) + '</td><td>' + (s.timeouts || 0) + '</td><td>' + (s.scanAverageMs || 0) + 'ms</td><td>' + (s.refreshAverageMs || 0) + 'ms</td></tr>';
      }
      html += '</table>';
    }
    if (snaps.length > 0) {
      html += '<div class=\"section\"><h3>Provider Snapshots (' + snaps.length + ')</h3><pre style=\"font-size:11px;max-height:200px;overflow:auto\">' + safeJson(snaps.slice(0, 5)) + '</pre></div>';
    }
    return html;
  }

  /* ---- AutoScanner ---- */
  function renderAutoScanner(d) {
    return '<div class=\"stat-grid\">' +
      statCard('File Events', d.totalFileEvents ?? 0) +
      statCard('Saves', d.totalSaves ?? 0) +
      statCard('Queued', d.totalQueued ?? 0) +
      statCard('Flushes', d.totalFlushes ?? 0) +
      statCard('Providers Executed', d.totalProvidersExecuted ?? 0) +
      statCard('Refreshes', d.totalRefreshesCompleted ?? 0) +
      statCard('Debounce Avg', (d.averageDebounceDelayMs || 0) + 'ms') +
      statCard('Flush Avg', (d.averageFlushDurationMs || 0) + 'ms') +
    '</div>' +
    '<div class=\"section\"><h3>Details</h3>' +
    detail('Creates', d.totalCreates ?? 0) +
    detail('Deletes', d.totalDeletes ?? 0) +
    detail('Renames', d.totalRenames ?? 0) +
    detail('Duplicates', d.totalDuplicateQueueAttempts ?? 0) +
    detail('Refreshes Failed', d.totalRefreshesFailed ?? 0) +
    detail('Reschedules', d.totalReschedules ?? 0) +
    '</div>';
  }

  /* ---- Diagnostics ---- */
  function renderDiagnostics(d) {
    var html = '<div class=\"stat-grid\">' +
      statCard('Changes', d.totalChanges ?? 0) +
      statCard('Mapped', d.totalMapped ?? 0) +
      statCard('Store Writes', d.totalStoreWrites ?? 0) +
      statCard('Errors', d.totalErrors ?? 0) +
    '</div>';
    if (d.byProvider) {
      html += '<div class=\"section\"><h3>By Provider</h3><table><tr><th>Provider</th><th>Changes</th><th>Mapped</th></tr>';
      for (var k in d.byProvider) {
        var p = d.byProvider[k];
        html += '<tr><td>' + esc(k) + '</td><td>' + (p.changes || 0) + '</td><td>' + (p.mapped || 0) + '</td></tr>';
      }
      html += '</table>';
    }
    return html;
  }

  /* ---- Folder ---- */
  function renderFolder(d) {
    return '<div class=\"stat-grid\">' +
      statCard('Rebuilds', d.totalRebuilds ?? 0) +
      statCard('Ancestor Updates', d.totalAncestorUpdates ?? 0) +
      statCard('Recomputes', d.totalRecomputes ?? 0) +
      statCard('Store Writes', d.totalStoreWrites ?? 0) +
      statCard('Propagations', d.totalPropagations ?? 0) +
      statCard('Aggregates', d.totalAggregates ?? 0) +
    '</div>' +
    '<div class=\"section\"><h3>Details</h3>' +
    detail('Rebuild Avg', (d.averageRebuildDurationMs || 0) + 'ms') +
    detail('Ancestor Update Avg', (d.averageAncestorUpdateDurationMs || 0) + 'ms') +
    detail('Active Folders', d.activeFolders ?? 0) +
    '</div>';
  }

  /* ---- Decoration ---- */
  function renderDecoration(d) {
    return '<div class=\"stat-grid\">' +
      statCard('Fire Events', d.totalFireEvents ?? 0) +
      statCard('Provide Events', d.totalProvideEvents ?? 0) +
      statCard('Decisions', d.totalDecisions ?? 0) +
      statCard('Errors', d.totalErrors ?? 0) +
    '</div>' +
    '<div class=\"section\"><h3>Details</h3>' +
    detail('Provide Avg Duration', (d.averageProvideDurationMs || 0) + 'ms') +
    detail('Refresh Count', d.totalRefreshStarts ?? 0) +
    detail('Cache Hit Rate', d.cacheHitRate != null ? (d.cacheHitRate * 100).toFixed(1) + '%' : '--') +
    '</div>';
  }

  /* ---- Pipeline ---- */
  function renderPipeline(d) {
    return '<div class=\"stat-grid\">' +
      statCard('Total Executions', d.totalExecutions ?? 0) +
      statCard('Active', d.activeExecutions ?? 0) +
      statCard('Completed', d.completedExecutions ?? 0) +
      statCard('Failed', d.failedExecutions ?? 0) +
      statCard('Cancelled', d.cancelledExecutions ?? 0) +
      statCard('Timed Out', d.timedOutExecutions ?? 0) +
      statCard('Throughput', (d.pipelineThroughput || 0) + '/s') +
      statCard('Peak Concurrent', d.concurrentPipelinePeak ?? 0) +
    '</div>' +
    '<div class=\"section\"><h3>Durations</h3>' +
    detail('Average', (d.averagePipelineDurationMs || 0) + 'ms') +
    detail('Peak', (d.peakPipelineDurationMs || 0) + 'ms') +
    '</div>';
  }

  /* ---- Assertions ---- */
  function renderAssertions(d) {
    var stats = d.statistics || {};
    var failures = d.failures || [];
    var rules = d.rules || [];
    var filter = state.filter || {};
    function matches(f) {
      if (filter.freeText) {
        var txt = filter.freeText.toLowerCase();
        var rule = (f.ruleName || f.name || '').toLowerCase();
        var cat = (f.category || '').toLowerCase();
        var sev = (f.severity || '').toLowerCase();
        if (rule.indexOf(txt) < 0 && cat.indexOf(txt) < 0 && sev.indexOf(txt) < 0) return false;
      }
      if (filter.severity && f.severity !== filter.severity) return false;
      return true;
    }
    function sevClass(s) {
      s = (s || '').toLowerCase();
      if (s === 'error' || s === 'critical') return 'red';
      if (s === 'warning') return 'yellow';
      return 'gray';
    }
    var filteredFailures = failures.filter(matches);
    return '<div class=\"search-bar\">' +
      '<input id=\"assertionSearch\" placeholder=\"Search by rule, category, severity...\" value=\"' + esc(filter.freeText || '') + '\" oninput=\"onAssertionFilter()\" style=\"flex:2\">' +
      '<select id=\"assertionSeverity\" onchange=\"onAssertionFilter()\">' +
        '<option value=\"\">All Severities</option>' +
        '<option value=\"Error\"' + (filter.severity === 'Error' ? ' selected' : '') + '>Error</option>' +
        '<option value=\"Warning\"' + (filter.severity === 'Warning' ? ' selected' : '') + '>Warning</option>' +
        '<option value=\"Info\"' + (filter.severity === 'Info' ? ' selected' : '') + '>Info</option>' +
      '</select>' +
    '</div>' +
    '<div class=\"stat-grid\">' +
      statCard('Total Rules', rules.length) +
      statCard('Active Failures', filteredFailures.length) +
      statCard('Total Executed', stats.totalExecuted ?? 0) +
      statCard('Total Failed', stats.totalFailed ?? 0) +
      statCard('Pass Rate', stats.totalExecuted > 0 ? ((1 - (stats.totalFailed || 0) / stats.totalExecuted) * 100).toFixed(1) + '%' : '--') +
    '</div>' +
    '<div class=\"section\"><h3>Active Failures (' + filteredFailures.length + ')</h3>' +
    (filteredFailures.length === 0 ? '<div class=\"empty-state\">' + (failures.length > 0 ? 'No failures match filter' : 'No active failures') + '</div>' :
    makeTable(['','Rule','Category','Severity','Count','Message'], filteredFailures, function(f) {
      return ['<span class=\"status-dot ' + sevClass(f.severity) + '\"></span>', esc(f.ruleName || f.name || '?'), esc(f.category || ''), esc(f.severity || ''), f.count ?? 1, esc((f.message || f.reason || '').substring(0,80))];
    })) + '</div>' +
    '<div class=\"section\"><h3>Rules (' + rules.length + ')</h3>' + makeTable(['Name','Category','Severity','Enabled'], rules, function(r) {
      return [esc(r.name), esc(r.category || ''), '<span class=\"status-dot ' + sevClass(r.severity) + '\"></span>' + esc(r.severity || ''), r.enabled ? '\\u2713' : '\\u2717'];
    }) + '</div>';
  }

  /* ---- Snapshots ---- */
  function renderSnapshots(d) {
    var snaps = d.snapshots || [];
    var stats = d.statistics || {};
    var html = '<div class=\"stat-grid\">' +
      statCard('Total Snapshots', snaps.length) +
      statCard('Total Triggers', stats.totalTriggers ?? 0) +
      statCard('Auto Captures', stats.autoCaptures ?? 0) +
      statCard('Manual Captures', stats.manualCaptures ?? 0) +
    '</div>' +
    '<div class=\"section\"><h3>Snapshots (' + snaps.length + ')</h3>' +
    (snaps.length === 0 ? '<div class=\"empty-state\">No snapshots</div>' :
    makeTable(['ID','Trigger','Timestamp','Sections','Actions'], snaps, function(s) {
      return [esc(s.metadata ? s.metadata.id : (s.id || '?')), esc(s.metadata ? s.metadata.trigger : (s.trigger || '?')), formatTime(s.metadata ? s.metadata.timestamp : s.timestamp), s.data ? Object.keys(s.data).length : (s.sections || 0), '<a href=\"#\" onclick=\"viewSnapshotDetails(\'' + esc(s.metadata ? s.metadata.id : (s.id || '')) + '\')\" style=\"color:var(--vscode-textLink-foreground)\">View</a>'];
    })) +
    '</div>' +
    '<div id=\"snapshotDetail\"></div>';
    return html;
  }

  /* ---- Timeline ---- */
  function renderTimeline(d) {
    var stats = d.statistics || {};
    var live = d.live || [];
    var historical = d.historical || [];
    var failed = d.failed || [];
    var filter = state.filter || {};
    function matches(t) {
      if (filter.uri && t.uri && t.uri.indexOf(filter.uri) < 0) return false;
      if (filter.provider && t.provider && t.provider.indexOf(filter.provider) < 0) return false;
      if (filter.pipelineId && t.pipelineId && t.pipelineId.indexOf(filter.pipelineId) < 0) return false;
      return true;
    }
    var filteredLive = live.filter(matches);
    var filteredHistorical = historical.filter(matches);
    var filteredFailed = failed.filter(matches);
    var html = '<div class=\"search-bar\">' +
      '<input id=\"timelineFilterUri\" placeholder=\"Filter by URI...\" value=\"' + esc(filter.uri || '') + '\" oninput=\"onTimelineFilter()\">' +
      '<input id=\"timelineFilterProvider\" placeholder=\"Filter by Provider...\" value=\"' + esc(filter.provider || '') + '\" oninput=\"onTimelineFilter()\">' +
      '<input id=\"timelineFilterPipeline\" placeholder=\"Filter by Pipeline ID...\" value=\"' + esc(filter.pipelineId || '') + '\" oninput=\"onTimelineFilter()\">' +
    '</div>' +
    '<div class=\"stat-grid\">' +
      statCard('Live', filteredLive.length) +
      statCard('Historical', filteredHistorical.length) +
      statCard('Failed', filteredFailed.length) +
      statCard('Total Events', stats.totalEvents ?? 0) +
    '</div>' +
    '<div class=\"section\"><h3>Live Timelines (' + filteredLive.length + ')</h3>' +
    (filteredLive.length === 0 ? '<div class=\"empty-state\">No live timelines' + (filter.uri || filter.provider || filter.pipelineId ? ' matching filter' : '') + '</div>' : makeTable(['ID','Status','Events','Actions'], filteredLive, function(t) {
      return [esc(t.id || '?'), esc(t.status || '?'), t.eventCount ?? t.events?.length ?? 0, '<a href=\"#\" onclick=\"requestTimelineDetails(\'' + esc(t.id || '') + '\')\" style=\"color:var(--vscode-textLink-foreground)\">Details</a>'];
    })) +
    '</div>' +
    '<div class=\"section\"><h3>Historical (' + filteredHistorical.length + ')</h3>' +
    (filteredHistorical.length === 0 ? '<div class=\"empty-state\">No historical timelines' + (filter.uri || filter.provider || filter.pipelineId ? ' matching filter' : '') + '</div>' : makeTable(['ID','Status','Events','Actions'], filteredHistorical, function(t) {
      return [esc(t.id || '?'), esc(t.status || '?'), t.eventCount ?? t.events?.length ?? 0, '<a href=\"#\" onclick=\"requestTimelineDetails(\'' + esc(t.id || '') + '\')\" style=\"color:var(--vscode-textLink-foreground)\">Details</a>'];
    })) +
    '</div>' +
    '<div class=\"section\"><h3>Failed (' + filteredFailed.length + ')</h3>' +
    (filteredFailed.length === 0 ? '<div class=\"empty-state\">No failed timelines' + (filter.uri || filter.provider || filter.pipelineId ? ' matching filter' : '') + '</div>' : makeTable(['ID','Error','Events','Actions'], filteredFailed, function(t) {
      return [esc(t.id || '?'), esc(t.error || t.status || '?'), t.eventCount ?? 0, '<a href=\"#\" onclick=\"requestTimelineDetails(\'' + esc(t.id || '') + '\')\" style=\"color:var(--vscode-textLink-foreground)\">Details</a>'];
    })) +
    '</div>' +
    '<div id=\"timelineDetail\"></div>';
    return html;
  }

  /* ---- File Logger ---- */
  function renderFileLogger(d) {
    var stats = d.statistics || {};
    var session = d.currentSession;
    var sessions = d.sessions || [];
    return '<div class=\"stat-grid\">' +
      statCard('Sessions', stats.totalSessions ?? sessions.length) +
      statCard('Total Entries', stats.totalEntries ?? 0) +
      statCard('Current Size', formatBytes(stats.totalBytes ?? 0)) +
      statCard('Writes Failed', stats.writeFailures ?? 0) +
    '</div>' +
    '<div class=\"section\"><h3>Current Session</h3>' +
    (session ? detail('Session ID', session.id || '?') + detail('Started', formatTime(session.startedAt)) + detail('Entries', session.entryCount ?? 0) : '<div class=\"empty-state\">No active session</div>') +
    '</div>' +
    '<div class=\"section\"><h3>Sessions (' + sessions.length + ')</h3>' +
    (sessions.length === 0 ? '<div class=\"empty-state\">No sessions</div>' : makeTable(['ID','Started','Entries'], sessions, function(s) { return [esc(s.id || '?'), formatTime(s.startedAt), s.entryCount ?? 0]; })) +
    '</div>';
  }

  /* ---- Performance ---- */
  function renderPerformance(d) {
    var html = '<div class=\"stat-grid\">' +
      statCard('Health Score', d.health ? d.health.score : '--', 'Level: ' + (d.health ? d.health.level : '--'), d.health ? getHealthColor(d.health.score) : undefined) +
      statCard('Throughput', (d.throughput || 0) + '/s') +
      statCard('Total Samples', (d.totalSamples || 0).toLocaleString()) +
      statCard('Bottlenecks', (d.bottlenecks || []).length) +
      statCard('Peak Queue', d.peakQueueSize ?? '--') +
    '</div>';
    if (d.resources) {
      html += '<div class=\"section\"><h3>Resources</h3>' +
        detail('Memory', (d.resources.memoryMb || 0) + ' MB') +
        detail('Heap Used', (d.resources.heapUsedMb || 0) + ' MB') +
        detail('Heap Total', (d.resources.heapTotalMb || 0) + ' MB') +
        detail('Active Pipelines', d.resources.activePipelines ?? 0) +
        detail('Active Scans', d.resources.activeScans ?? 0) +
        detail('Queued Writes', d.resources.queuedWrites ?? 0) +
        detail('Snapshot Count', d.resources.snapshotCount ?? 0) +
        '</div>';
    }
    if (d.latency) {
      var latencyKeys = Object.keys(d.latency);
      if (latencyKeys.length > 0) {
        html += '<div class=\"section\"><h3>Latency Metrics (' + latencyKeys.length + ')</h3><table><tr><th>Metric</th><th>Avg</th><th>Min</th><th>Max</th><th>p50</th><th>p95</th><th>p99</th><th>Samples</th></tr>';
        for (var k = 0; k < latencyKeys.length; k++) {
          var l = d.latency[latencyKeys[k]];
          html += '<tr><td>' + esc(latencyKeys[k]) + '</td><td>' + (l.averageMs || 0) + 'ms</td><td>' + (l.minMs || 0) + 'ms</td><td>' + (l.maxMs || 0) + 'ms</td><td>' + (l.p50Ms || 0) + 'ms</td><td>' + (l.p95Ms || 0) + 'ms</td><td>' + (l.p99Ms || 0) + 'ms</td><td>' + (l.sampleCount || 0) + '</td></tr>';
        }
        html += '</table>';
      }
    }
    if (d.slowestOperation) {
      html += '<div class=\"section\"><h3>Slowest Operation</h3>' +
        detail('Metric', d.slowestOperation.metric || '') +
        detail('Duration', (d.slowestOperation.valueMs || 0) + 'ms') +
        detail('Timestamp', formatTime(d.slowestOperation.timestamp)) +
        '</div>';
    }
    if (d.health && d.health.reasons && d.health.reasons.length > 0) {
      html += '<div class=\"section\"><h3>Health Deductions</h3><ul>';
      for (var r = 0; r < d.health.reasons.length; r++) {
        html += '<li style=\"color:var(--vscode-errorForeground,#f48771)\">\\u26A0 ' + esc(d.health.reasons[r]) + '</li>';
      }
      html += '</ul></div>';
    }
    if (d.bottlenecks && d.bottlenecks.length > 0) {
      html += '<div class=\"section\"><h3>Bottlenecks</h3><table><tr><th>Bottleneck</th></tr>';
      for (var b = 0; b < d.bottlenecks.length; b++) {
        html += '<tr><td><span class=\"status-dot red\"></span>' + esc(d.bottlenecks[b]) + '</td></tr>';
      }
      html += '</table></div>';
    }
    if (d.provider && d.provider.length > 0) {
      html += '<div class=\"section\"><h3>Provider Performance</h3>' + makeTable(['Provider','Scans','Avg Scan','Refreshes','Avg Refresh','Failures','Timeouts'], d.provider, function(p) {
        return [esc(p.provider), p.scanCount || 0, (p.scanAverageMs || 0) + 'ms', p.refreshCount || 0, (p.refreshAverageMs || 0) + 'ms', p.failures || 0, p.timeouts || 0];
      }) + '</div>';
    }
    html += '<div style=\"text-align:right;font-size:10px;color:var(--vscode-descriptionForeground);padding-top:8px\">Last updated: ' + formatTime(Date.now()) + ' | Tracked since: ' + formatTime(d.trackedSince) + '</div>';
    return html;
  }

  /* ---- Export ---- */
  function renderExport() {
    return '<h2>Export</h2><div class=\"stat-grid\">' +
      clickCard('Export Overview', 'JSON', 'Download system overview', 'overview') +
      clickCard('Export Performance', 'JSON', 'Download performance report', 'performance') +
      clickCard('Export Assertions', 'JSON', 'Download assertion report', 'assertions') +
      clickCard('Export Snapshots', 'JSON', 'Download all snapshots', 'snapshots') +
      clickCard('Export Timelines', 'JSON', 'Download timeline data', 'timeline') +
    '</div>';
  }

  /* ---- Helpers ---- */
  function statCard(label, value, sub, color) {
    return '<div class=\"stat-card\"><div class=\"label\">' + esc(label) + '</div><div class=\"value\"' + (color ? ' style=\"color:' + color + '\"' : '') + '>' + esc(value) + '</div>' + (sub ? '<div class=\"sub\">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function clickCard(label, value, sub, scope) {
    return '<div class=\"stat-card\" style=\"cursor:pointer\" onclick=\"vscode.postMessage({type:\'requestExport\',format:\'json\',scope:\'' + scope + '\'})\"><div class=\"label\">' + label + '</div><div class=\"value\" style=\"font-size:14px\">' + value + '</div><div class=\"sub\">' + sub + '</div></div>';
  }
  function detail(label, value) {
    return '<div class=\"detail-row\"><span class=\"detail-label\">' + esc(label) + '</span><span class=\"detail-value\">' + esc(value) + '</span></div>';
  }
  function makeTable(headers, rows, fn) {
    var h = '<table><tr>' + headers.map(function(hdr) { return '<th>' + hdr + '</th>'; }).join('') + '</tr>';
    for (var i = 0; i < rows.length; i++) {
      var cells = fn(rows[i]);
      h += '<tr>' + cells.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }
    return h + '</table>';
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\'/g,'&#39;').replace(/\x60/g,'&#96;'); }
  function formatUptime(sec) {
    if (sec == null) return '--';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h > 0 ? h + 'h ' + m + 'm ' + s + 's' : m > 0 ? m + 'm ' + s + 's' : s + 's';
  }
  function formatTime(ts) {
    if (!ts) return '--';
    try { return new Date(ts).toLocaleTimeString(); } catch(e) { return String(ts); }
  }
  function formatBytes(b) {
    if (!b) return '0 B';
    var u = ['B','KB','MB','GB'], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(1) + ' ' + u[i];
  }
  function safeJson(obj) { try { return JSON.stringify(obj, null, 2); } catch(e) { return String(obj); } }
  function getHealthColor(score) {
    if (score == null) return 'var(--vscode-descriptionForeground)';
    if (score >= 80) return '#4ec9b0';
    if (score >= 60) return '#dcdcaa';
    if (score >= 30) return '#d7ba7d';
    return '#f44747';
  }

  /* ---- Timeline Search (exposed globally for inline onclick) ---- */
  window.onTimelineFilter = function() {
    state.filter = state.filter || {};
    state.filter.uri = document.getElementById('timelineFilterUri')?.value || '';
    state.filter.provider = document.getElementById('timelineFilterProvider')?.value || '';
    state.filter.pipelineId = document.getElementById('timelineFilterPipeline')?.value || '';
    var d = state.data['timeline'];
    if (d) content.innerHTML = renderTimeline(d);
  };
  window.onAssertionFilter = function() {
    state.filter = state.filter || {};
    state.filter.freeText = document.getElementById('assertionSearch')?.value || '';
    state.filter.severity = document.getElementById('assertionSeverity')?.value || '';
    var d = state.data['assertions'];
    if (d) content.innerHTML = renderAssertions(d);
  };
  window.requestTimelineDetails = function(id) {
    var d = state.data['timeline'];
    if (!d) return;
    var all = (d.live || []).concat(d.historical || []).concat(d.failed || []);
    var tl = null;
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) { tl = all[i]; break; } }
    if (!tl) return;
    var detailEl = document.getElementById('timelineDetail');
    if (!detailEl) return;
    detailEl.innerHTML = '<div class=\"section\"><h3>Timeline: ' + esc(id) + '</h3>' +
      detail('Status', tl.status || '?') +
      detail('Events', tl.eventCount ?? tl.events?.length ?? 0) +
      (tl.error ? detail('Error', tl.error) : '') +
      (tl.durationMs ? detail('Duration', tl.durationMs + 'ms') : '') +
      (tl.startedAt ? detail('Started', formatTime(tl.startedAt)) : '') +
      (tl.completedAt ? detail('Completed', formatTime(tl.completedAt)) : '') +
      '</div><pre style=\"font-size:11px;background:var(--vscode-editorWidget-background);padding:8px;border-radius:4px;overflow:auto;max-height:300px\">' + safeJson(tl) + '</pre>';
  };
  window.viewSnapshotDetails = function(id) {
    var d = state.data['snapshots'];
    if (!d) return;
    var snaps = d.snapshots || [];
    var snap = null;
    for (var i = 0; i < snaps.length; i++) {
      var sid = snaps[i].metadata ? snaps[i].metadata.id : (snaps[i].id || '');
      if (sid === id) { snap = snaps[i]; break; }
    }
    if (!snap) return;
    var detailEl = document.getElementById('snapshotDetail');
    if (!detailEl) return;
    var meta = snap.metadata || {};
    var sectionsHtml = '';
    if (snap.data) {
      sectionsHtml = '<div class=\"section\"><h3>Data Sections (' + Object.keys(snap.data).length + ')</h3>';
      for (var k in snap.data) {
        sectionsHtml += detail(k, typeof snap.data[k] === 'object' ? Object.keys(snap.data[k]).length + ' entries' : String(snap.data[k]));
      }
      sectionsHtml += '</div>';
    }
    detailEl.innerHTML = '<div class=\"section\"><h3>Snapshot: ' + esc(id) + '</h3>' +
      detail('Trigger', meta.trigger || snap.trigger || '?') +
      detail('Timestamp', formatTime(meta.timestamp || snap.timestamp)) +
      detail('Extension Version', meta.extensionVersion || '') +
      detail('VS Code Version', meta.vscodeVersion || '') +
      (meta.durationMs ? detail('Capture Duration', meta.durationMs + 'ms') : '') +
      sectionsHtml +
      '</div><pre style=\"font-size:11px;background:var(--vscode-editorWidget-background);padding:8px;border-radius:4px;overflow:auto;max-height:400px\">' + safeJson(snap) + '</pre>';
  };
    var d = state.data['timeline'];
    if (!d) return;
    var all = (d.live || []).concat(d.historical || []).concat(d.failed || []);
    var tl = null;
    for (var i = 0; i < all.length; i++) { if (all[i].id === id) { tl = all[i]; break; } }
    if (!tl) return;
    var detailEl = document.getElementById('timelineDetail');
    if (!detailEl) return;
    detailEl.innerHTML = '<div class=\"section\"><h3>Timeline: ' + esc(id) + '</h3>' +
      detail('Status', tl.status || '?') +
      detail('Events', tl.eventCount ?? tl.events?.length ?? 0) +
      (tl.error ? detail('Error', tl.error) : '') +
      (tl.durationMs ? detail('Duration', tl.durationMs + 'ms') : '') +
      (tl.startedAt ? detail('Started', formatTime(tl.startedAt)) : '') +
      (tl.completedAt ? detail('Completed', formatTime(tl.completedAt)) : '') +
      '</div><pre style=\"font-size:11px;background:var(--vscode-editorWidget-background);padding:8px;border-radius:4px;overflow:auto;max-height:300px\">' + safeJson(tl) + '</pre>';
  };

  /* ---- Message Handling ---- */
  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'dataUpdate':
        state.data[msg.panel] = msg.data;
        state.loading[msg.panel] = false;
        if (msg.panel === state.currentPanel) content.innerHTML = renderPanel(msg.panel, msg.data);
        if (msg.panel === 'overview' && msg.data) {
          healthBadge.textContent = msg.data.healthLevel || '--';
          healthBadge.style.background = getHealthColor(msg.data.healthScore);
        }
        break;
      case 'error':
        content.innerHTML = '<div class=\"error-banner\">\\u26A0 ' + esc(msg.message) + '</div>';
        break;
    }
  });

  /* ---- Init ---- */
  renderNav();
  vscode.postMessage({ type: 'viewReady' });
})();
</script>
</body>
</html>`;
  }
}
