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
    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      background: var(--vscode-titleBar-activeBackground, #323233);
      border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
      flex-shrink: 0;
    }
    .header h1 {
      font-size: 16px;
      font-weight: 600;
      flex: 1;
    }
    .header .badge {
      font-size: 11px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      padding: 2px 8px;
      border-radius: 10px;
      margin-left: 8px;
    }

    /* Navigation sidebar */
    .layout {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .sidebar {
      width: 180px;
      background: var(--vscode-sideBar-background, #252526);
      border-right: 1px solid var(--vscode-panel-border, #3c3c3c);
      overflow-y: auto;
      flex-shrink: 0;
    }
    .nav-item {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.15s;
    }
    .nav-item:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .nav-item.active {
      background: var(--vscode-list-activeSelectionBackground, #094771);
      color: var(--vscode-list-activeSelectionForeground, #fff);
      border-left-color: var(--vscode-focusBorder, #007fd4);
    }
    .nav-item .icon {
      width: 20px;
      text-align: center;
      margin-right: 8px;
    }

    /* Content area */
    .content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    .panel {
      display: none;
    }
    .panel.active {
      display: block;
    }

    /* Status indicators */
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .status-dot.green { background: #4ec9b0; }
    .status-dot.yellow { background: #dcdcaa; }
    .status-dot.red { background: #f44747; }
    .status-dot.gray { background: #6a6a6a; }

    /* Stat cards */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #3c3c3c);
      border-radius: 6px;
      padding: 12px;
    }
    .stat-card .label {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground, #8c8c8c);
      margin-bottom: 4px;
    }
    .stat-card .value {
      font-size: 22px;
      font-weight: 600;
    }
    .stat-card .sub {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #8c8c8c);
      margin-top: 2px;
    }

    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    th, td {
      text-align: left;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
    }
    th {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground, #8c8c8c);
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    tr:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }

    /* Loading spinner */
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid var(--vscode-editor-foreground, #ccc);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .loading-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px;
      gap: 8px;
    }

    .error-banner {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      border-radius: 4px;
      padding: 8px 12px;
      margin-bottom: 12px;
    }

    .empty-state {
      text-align: center;
      padding: 32px;
      color: var(--vscode-descriptionForeground, #8c8c8c);
    }

    /* Search bar */
    .search-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .search-bar input, .search-bar select {
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 12px;
    }
    .search-bar input { flex: 1; min-width: 150px; }
    .search-bar input:focus, .search-bar select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #424242); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, #555); }
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

      /* ---- Navigation ---- */
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

      function renderNav() {
        sidebar.innerHTML = panels.map(p => \`
          <div class="nav-item \${state.currentPanel === p.id ? 'active' : ''}" data-panel="\${p.id}">
            <span class="icon">\${p.icon}</span>
            <span>\${p.label}</span>
          </div>
        \`).join('');

        sidebar.querySelectorAll('.nav-item').forEach(el => {
          el.addEventListener('click', () => {
            const panel = el.dataset.panel;
            state.currentPanel = panel;
            renderNav();
            vscode.postMessage({ type: 'navigate', panel });
          });
        });
      }

      /* ---- Panel Renderers ---- */
      function renderPanel(panelId, data) {
        switch (panelId) {
          case 'overview': return renderOverview(data);
          case 'store': return renderPlaceholder('Store Monitor', data);
          case 'provider': return renderPlaceholder('Provider Monitor', data);
          case 'autoscanner': return renderPlaceholder('AutoScanner Monitor', data);
          case 'diagnostics': return renderPlaceholder('Diagnostics Monitor', data);
          case 'folder': return renderPlaceholder('Folder Monitor', data);
          case 'decoration': return renderPlaceholder('Decoration Monitor', data);
          case 'pipeline': return renderPlaceholder('EventPipeline Monitor', data);
          case 'assertions': return renderPlaceholder('Runtime Assertions', data);
          case 'snapshots': return renderPlaceholder('Snapshot Viewer', data);
          case 'timeline': return renderPlaceholder('Timeline Viewer', data);
          case 'filelogger': return renderPlaceholder('File Logger', data);
          case 'performance': return renderPlaceholder('Performance Monitor', data);
          case 'export': return renderExportPanel();
          default: return '<div class="empty-state">Unknown panel</div>';
        }
      }

      function renderOverview(data) {
        if (!data) return '<div class="loading-overlay"><span class="spinner"></span> Loading...</div>';
        const d = data;
        return \`
          <div class="stat-grid">
            <div class="stat-card">
              <div class="label">Health Score</div>
              <div class="value" style="color:\${getHealthColor(d.healthScore)}">\${d.healthScore ?? '--'}</div>
              <div class="sub">Level: \${d.healthLevel ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Memory</div>
              <div class="value">\${d.memoryMb ?? '--'} MB</div>
              <div class="sub">heap usage</div>
            </div>
            <div class="stat-card">
              <div class="label">Active Providers</div>
              <div class="value">\${d.activeProviders ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Active Scans</div>
              <div class="value">\${d.activeScans ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Active Pipelines</div>
              <div class="value">\${d.activePipelines ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Snapshots</div>
              <div class="value">\${d.snapshotCount ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Assertion Failures</div>
              <div class="value">\${d.assertionFailures ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Events Processed</div>
              <div class="value">\${d.totalEventsProcessed ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Errors</div>
              <div class="value">\${d.totalErrors ?? '--'}</div>
            </div>
            <div class="stat-card">
              <div class="label">Uptime</div>
              <div class="value">\${formatUptime(d.uptimeSec)}</div>
            </div>
          </div>
          <table>
            <tr><th>Property</th><th>Value</th></tr>
            <tr><td>Extension Version</td><td>\${d.extensionVersion ?? '--'}</td></tr>
            <tr><td>VS Code Version</td><td>\${d.vscodeVersion ?? '--'}</td></tr>
          </table>
        \`;
      }

      function renderPlaceholder(title, data) {
        return \`
          <h2>\${title}</h2>
          <div class="empty-state">
            <p style="font-size:16px;margin-bottom:8px">\\u{1F6A7} Panel data incoming</p>
            <p>Data provider will populate this panel with live statistics.</p>
            <pre style="margin-top:12px;font-size:11px;text-align:left;background:var(--vscode-editorWidget-background);padding:8px;border-radius:4px;overflow:auto">\${data ? JSON.stringify(data, null, 2) : 'No data yet'}</pre>
          </div>
        \`;
      }

      function renderExportPanel() {
        return \`
          <h2>Export</h2>
          <div class="stat-grid">
            <div class="stat-card" style="cursor:pointer" onclick="vscode.postMessage({type:'requestExport',format:'json',scope:'overview'})">
              <div class="label">Export Overview</div>
              <div class="value" style="font-size:14px">JSON</div>
              <div class="sub">Download system overview snapshot</div>
            </div>
            <div class="stat-card" style="cursor:pointer" onclick="vscode.postMessage({type:'requestExport',format:'json',scope:'performance'})">
              <div class="label">Export Performance</div>
              <div class="value" style="font-size:14px">JSON</div>
              <div class="sub">Download performance report</div>
            </div>
            <div class="stat-card" style="cursor:pointer" onclick="vscode.postMessage({type:'requestExport',format:'json',scope:'assertions'})">
              <div class="label">Export Assertions</div>
              <div class="value" style="font-size:14px">JSON</div>
              <div class="sub">Download assertion report</div>
            </div>
            <div class="stat-card" style="cursor:pointer" onclick="vscode.postMessage({type:'requestExport',format:'json',scope:'snapshots'})">
              <div class="label">Export Snapshots</div>
              <div class="value" style="font-size:14px">JSON</div>
              <div class="sub">Download all snapshots</div>
            </div>
            <div class="stat-card" style="cursor:pointer" onclick="vscode.postMessage({type:'requestExport',format:'json',scope:'timeline'})">
              <div class="label">Export Timelines</div>
              <div class="value" style="font-size:14px">JSON</div>
              <div class="sub">Download timeline data</div>
            </div>
          </div>
        \`;
      }

      /* ---- Helpers ---- */
      function getHealthColor(score) {
        if (score == null) return 'var(--vscode-descriptionForeground)';
        if (score >= 80) return '#4ec9b0';
        if (score >= 60) return '#dcdcaa';
        if (score >= 30) return '#d7ba7d';
        return '#f44747';
      }

      function formatUptime(sec) {
        if (sec == null) return '--';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        if (h > 0) return \`\${h}h \${m}m \${s}s\`;
        if (m > 0) return \`\${m}m \${s}s\`;
        return \`\${s}s\`;
      }

      /* ---- Message Handling ---- */
      window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
          case 'dataUpdate': {
            state.data[msg.panel] = msg.data;
            state.loading[msg.panel] = false;
            if (msg.panel === state.currentPanel) {
              content.innerHTML = renderPanel(msg.panel, msg.data);
            }
            if (msg.panel === 'overview' && msg.data) {
              healthBadge.textContent = msg.data.healthLevel ?? '--';
              healthBadge.style.background = getHealthColor(msg.data.healthScore);
            }
            break;
          }
          case 'error': {
            content.innerHTML = \`<div class="error-banner">\\u26A0 \${msg.message}</div>\`;
            break;
          }
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
