import type { TelemetrySubscription } from '../TelemetryBus';

/* ------------------------------------------------------------------ */
/*  Dashboard Options                                                  */
/* ------------------------------------------------------------------ */

export interface DashboardOptions {
  readonly autoRefreshIntervalMs: number;
  readonly maxHistoryEvents: number;
}

export const DEFAULT_DASHBOARD_OPTIONS: DashboardOptions = {
  autoRefreshIntervalMs: 2000,
  maxHistoryEvents: 10000,
};

/* ------------------------------------------------------------------ */
/*  Dashboard View State                                               */
/* ------------------------------------------------------------------ */

export type DashboardPanelType =
  | 'overview'
  | 'store'
  | 'provider'
  | 'autoscanner'
  | 'diagnostics'
  | 'folder'
  | 'decoration'
  | 'pipeline'
  | 'assertions'
  | 'snapshots'
  | 'timeline'
  | 'filelogger'
  | 'performance'
  | 'export';

/* ------------------------------------------------------------------ */
/*  Dashboard Message Protocol                                         */
/* ------------------------------------------------------------------ */

export interface DashboardFilter {
  readonly uri?: string;
  readonly provider?: string;
  readonly pipelineId?: string;
  readonly eventType?: string;
  readonly timeRange?: { readonly from: number; readonly to: number };
  readonly severity?: string;
  readonly freeText?: string;
}

export type DashboardMessage =
  /* View → Controller */
  | { readonly type: 'viewReady' }
  | { readonly type: 'navigate'; readonly panel: DashboardPanelType }
  | { readonly type: 'setFilter'; readonly filter: DashboardFilter }
  | { readonly type: 'requestData'; readonly panel: DashboardPanelType }
  | { readonly type: 'requestTimeline'; readonly traceId: string }
  | { readonly type: 'requestSnapshot'; readonly snapshotId: string }
  | { readonly type: 'requestExport'; readonly format: 'json' | 'csv' | 'text'; readonly scope: DashboardPanelType }
  | { readonly type: 'refresh' }
  /* Controller → View */
  | { readonly type: 'dataUpdate'; readonly panel: DashboardPanelType; readonly data: unknown }
  | { readonly type: 'error'; readonly message: string };

/* ------------------------------------------------------------------ */
/*  Dashboard Statistics (aggregated snapshot)                         */
/* ------------------------------------------------------------------ */

export interface DashboardSnapshot {
  readonly timestamp: number;
  readonly overview: SystemOverviewData;
  readonly panels: Partial<Record<DashboardPanelType, unknown>>;
}

export interface SystemOverviewData {
  readonly extensionVersion: string;
  readonly vscodeVersion: string;
  readonly uptimeSec: number;
  readonly activeProviders: number;
  readonly activeScans: number;
  readonly activePipelines: number;
  readonly snapshotCount: number;
  readonly assertionFailures: number;
  readonly healthScore: number;
  readonly healthLevel: string;
  readonly totalEventsProcessed: number;
  readonly telemetryErrorCount: number;
  readonly totalErrors: number;
  readonly memoryMb: number;
}

/* ------------------------------------------------------------------ */
/*  Data provider interface (each monitor implements this)             */
/* ------------------------------------------------------------------ */

export interface MonitorDataProvider<TStats, TSnapshot> {
  getStatistics(): TStats;
  captureSnapshot(): TSnapshot;
}

/* ------------------------------------------------------------------ */
/*  View interface (abstracted for testability)                        */
/* ------------------------------------------------------------------ */

export interface DashboardViewApi {
  readonly disposed: boolean;
  show(): void;
  postMessage(message: DashboardMessage): void;
  setMessageHandler(handler: (message: DashboardMessage) => void): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/*  Controller interface                                              */
/* ------------------------------------------------------------------ */

export interface DashboardControllerApi {
  setView(view: DashboardViewApi): void;
  handleMessage(message: DashboardMessage): void;
  refreshAll(): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/*  Dashboard page descriptors for navigation                          */
/* ------------------------------------------------------------------ */

export interface PanelDescriptor {
  readonly id: DashboardPanelType;
  readonly label: string;
  readonly icon: string;
  readonly description: string;
}

export const ALL_PANELS: readonly PanelDescriptor[] = [
  { id: 'overview', label: 'Overview', icon: '$(dashboard)', description: 'Live system overview' },
  { id: 'store', label: 'Store', icon: '$(database)', description: 'ProblemStore monitor' },
  { id: 'provider', label: 'Providers', icon: '$(extensions)', description: 'Provider monitor' },
  { id: 'autoscanner', label: 'AutoScanner', icon: '$(play)', description: 'AutoScanner monitor' },
  { id: 'diagnostics', label: 'Diagnostics', icon: '$(beaker)', description: 'Diagnostics monitor' },
  { id: 'folder', label: 'Folder', icon: '$(folder)', description: 'Folder monitor' },
  { id: 'decoration', label: 'Decoration', icon: '$(paintcan)', description: 'Decoration monitor' },
  { id: 'pipeline', label: 'Pipeline', icon: '$(circuit-board)', description: 'EventPipeline monitor' },
  { id: 'assertions', label: 'Assertions', icon: '$(check)', description: 'Runtime assertions' },
  { id: 'snapshots', label: 'Snapshots', icon: '$(camera)', description: 'Snapshot system' },
  { id: 'timeline', label: 'Timeline', icon: '$(history)', description: 'Timeline generator' },
  { id: 'filelogger', label: 'File Logger', icon: '$(note)', description: 'File logger' },
  { id: 'performance', label: 'Performance', icon: '$(rocket)', description: 'Performance monitor' },
  { id: 'export', label: 'Export', icon: '$(save)', description: 'Export data' },
];

/* ------------------------------------------------------------------ */
/*  Webview message types to/from the HTML side                        */
/* ------------------------------------------------------------------ */

export interface WebviewState {
  readonly currentPanel: DashboardPanelType;
  readonly filter: DashboardFilter;
  readonly data: Record<string, unknown>;
  readonly loading: Record<string, boolean>;
  readonly error: string | undefined;
}

export function createInitialWebviewState(): WebviewState {
  return {
    currentPanel: 'overview',
    filter: {},
    data: {},
    loading: {},
    error: undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Re-exports for convenience                                        */
/* ------------------------------------------------------------------ */

export type { TelemetrySubscription };
