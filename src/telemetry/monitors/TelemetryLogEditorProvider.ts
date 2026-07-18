import * as vscode from 'vscode';

/** Custom editor for .jsonl telemetry log files — renders color-coded event stream */
export class TelemetryLogEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'problemExplorer.telemetryLogViewer';

  constructor(_extensionUri: vscode.Uri) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.getHtml();

    const render = () => {
      const events = this.parseLog(document.getText());
      webviewPanel.webview.postMessage({ type: 'render', events });
      webviewPanel.title = `Telemetry Log: ${document.uri.fsPath.split(/[/\\]/).pop()}`;
    };

    render();

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) render();
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());
  }

  private parseLog(text: string): any[] {
    const events: any[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.type) events.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
    return events;
  }

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
  font-size: 12px;
  color: var(--vscode-editor-foreground, #d4d4d4);
  background: var(--vscode-editor-background, #1e1e1e);
  padding: 8px;
}
.toolbar {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border, #333);
  margin-bottom: 8px;
}
.toolbar input {
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #ccc);
  border: 1px solid var(--vscode-input-border, #555);
  padding: 2px 6px; font-size: 12px; width: 160px; font-family: inherit;
}
.toolbar input::placeholder { opacity: 0.4; }
.toolbar button {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  border: none; padding: 3px 10px; cursor: pointer; font-size: 12px;
}
.toolbar button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
.toolbar .stats { font-size: 11px; opacity: 0.6; margin-left: auto; }

#eventList { max-height: 80vh; overflow-y: auto; }
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
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #424242); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, #4f4f4f); }
</style>
</head>
<body>
<div class="toolbar">
  <input id="filterType" placeholder="filter by event type" />
  <button id="applyFilter">Apply</button>
  <button id="clearFilter">Clear</button>
  <span class="stats" id="statsBar">0 events</span>
</div>
<div id="eventList"></div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  let allEvents = [];
  let filter = '';

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (m) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]; }); }

  function renderEvents(events) {
    const list = document.getElementById('eventList');
    list.innerHTML = '';
    for (const e of events) {
      const div = document.createElement('div');
      div.className = 'event';
      if (e.type === 'assertion.failure' || e.phase === 'error') div.classList.add('err');
      else if (e.type.startsWith('provider.scan')) div.classList.add('scan');
      else if (e.type.startsWith('store.')) div.classList.add('store');
      else if (e.type.startsWith('decoration.')) div.classList.add('decoration');
      else if (e.type.startsWith('folder.')) div.classList.add('folder');
      else if (e.type.startsWith('timer.')) div.classList.add('timer');
      else if (e.type.startsWith('pipeline.')) div.classList.add('pipeline');
      else if (e.type.startsWith('perf.')) div.classList.add('perf');
      else if (e.type.startsWith('assertion.')) div.classList.add('assertion');

      const time = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 23) : '';
      const src = e.source || '';
      const tid = e.traceId ? String(e.traceId).slice(0, 16) : '';

      div.innerHTML = '<span class="time">' + time + '</span>'
        + '<span class="type">' + escapeHtml(e.type) + '</span>'
        + (src ? '<span class="src">' + escapeHtml(src) + '</span>' : '')
        + '<span class="tid">' + escapeHtml(tid) + '</span>';

      const detail = e.detail || e.error || e.message || e.phase || '';
      if (detail) div.innerHTML += '<span style="opacity:0.5;margin-left:6px;">' + escapeHtml(String(detail).slice(0, 80)) + '</span>';

      div.title = JSON.stringify(e, null, 2);
      list.appendChild(div);
    }
    document.getElementById('statsBar').textContent = events.length + '/' + allEvents.length + ' events';
  }

  function applyFilter() {
    const f = document.getElementById('filterType').value.trim().toLowerCase();
    if (!f) { renderEvents(allEvents); return; }
    renderEvents(allEvents.filter(function (e) { return e.type.toLowerCase().includes(f); }));
  }

  window.addEventListener('message', function (msg) {
    if (msg.data.type === 'render') {
      allEvents = msg.data.events;
      applyFilter();
    }
  });

  document.getElementById('applyFilter').addEventListener('click', applyFilter);
  document.getElementById('clearFilter').addEventListener('click', function () {
    document.getElementById('filterType').value = '';
    filter = '';
    renderEvents(allEvents);
  });
  document.getElementById('filterType').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') applyFilter();
  });
})();
</script>
</body>
</html>`;
  }
}
