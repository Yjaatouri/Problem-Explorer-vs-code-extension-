// Core types for the Workspace Diagnostics Engine.
//
// NOTE: this package is editor-agnostic. The `Uri` interface below is the
// engine's own structural match to `vscode.Uri` — consumers pass real
// vscode.Uri objects (structurally compatible) or construct their own.

export type { Schema } from 'jsonschema';
import type { Schema } from 'jsonschema';

/** Engine URI — structural match to `vscode.Uri`. Never import `vscode` here. */
export interface Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly fsPath: string;
  toString(): string;
  with(change: Partial<Pick<Uri, 'scheme' | 'authority' | 'path'>>): Uri;
}

/** Ordering matches worst-severity-wins: None < Info < Warning < Error */
export enum ProblemSeverity {
  None = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
}

/** Immutable value object for the diagnostics summary of one file or folder */
export interface ProblemState {
  readonly severity: ProblemSeverity;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  /** Files contributing to this state (1 for a single file, aggregated for folders) */
  readonly fileCount: number;
}

/** Zero state constant */
export const ZERO_PROBLEM_STATE: ProblemState = {
  severity: ProblemSeverity.None,
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
  fileCount: 0,
};

/** Authoritativeness of a provider's results. Higher wins ownership. */
export enum ConfidenceTier {
  WorkspaceScanner = 3, // tsc, eslint, ruff — full workspace scans, authoritative
  Realtime = 2, // vscode-diagnostics — live but limited to open files
  Fallback = 1, // future: heuristic providers, AI suggestions
}

/** Cost classification used for scheduling. */
export type Cost = 'cheap' | 'medium' | 'expensive';

/** The only four scan triggers. Adding a fifth is a milestone decision. */
export enum ScanType {
  Startup = 'startup',
  Save = 'save',
  Manual = 'manual',
  Periodic = 'periodic',
}

/** Queue ordering for scan jobs. Manual > Save > Periodic > Startup. */
export type ScanPriority = 'manual' | 'save' | 'periodic' | 'startup';

/** Provider health states */
export enum ProviderHealth {
  /** Registered but not yet health-checked (§11.1 initial state) */
  Unknown = 'unknown',
  Ready = 'ready',
  Unavailable = 'unavailable',
  MissingDependency = 'missing_dependency',
  Misconfigured = 'misconfigured',
  Scanning = 'scanning',
  Failed = 'failed',
}

/** Provider status with transition metadata */
export interface ProviderStatus {
  readonly health: ProviderHealth;
  readonly message?: string;
  readonly lastCheckMs: number;
  readonly lastScanMs?: number;
  readonly lastError?: Error;
}

/** Provider capability declaration */
export interface ProviderCapabilities {
  readonly confidenceTier: ConfidenceTier;
  readonly supportedConfigTypes: readonly ConfigType[];
  readonly workspaceScan: boolean;
  readonly incrementalScan: boolean;
  readonly realtime: boolean;
  readonly extensions: readonly string[];
  readonly cost: Cost;
}

/** Scan request context handed to a provider */
export interface ScanContext {
  readonly type: ScanType;
  readonly trigger: 'startup' | 'save' | 'manual' | 'timer' | 'config-change';
  readonly uris?: readonly Uri[];
  readonly providerId?: string;
}

/**
 * The minimal unit of requested work. Produced by the ImpactAnalyzer,
 * consumed by the scheduler. The scheduler NEVER infers scope itself.
 */
export interface ScanPlan {
  readonly capability: ConfigType;
  readonly scope: 'file' | 'workspace';
  readonly uris: readonly Uri[];
  readonly priority: ScanPriority;
}

/** Scan job in the scheduler queue */
export interface ScanJob {
  readonly id: string;
  readonly capability: ConfigType;
  readonly scope: 'file' | 'workspace';
  readonly type: ScanType;
  readonly uris: readonly Uri[];
  readonly priority: ScanPriority;
  readonly cost: Cost;
  readonly enqueuedMs: number;
}

/** Diagnostics produced by one scan for one file (part of a ScanResult) */
export interface ScannedFileDiagnostics {
  readonly uri: Uri;
  readonly diagnostics: readonly Diagnostic[];
}

/** Scan result from a provider */
export interface ScanResult {
  /** Every URI the scan covered, regardless of outcome. */
  readonly changedUris: readonly Uri[];
  /** Per-file diagnostics. Entries are merged into the store, then released. */
  readonly files?: readonly ScannedFileDiagnostics[];
  readonly errors?: readonly ScanErrorInfo[];
}

/** Scan error info (the ScanError class lives in ../errors) */
export interface ScanErrorInfo {
  readonly uri: Uri;
  readonly message: string;
  readonly code?: string;
}

/** Project configuration discovered by WorkspaceIndex */
export interface ProjectConfig {
  readonly root: Uri;
  readonly type: ConfigType;
  readonly configFiles: readonly Uri[];
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
}

/** Configuration types the engine understands. Open set — providers extend it. */
export type ConfigType =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'php'
  | 'csharp'
  | 'java'
  | 'cpp'
  | 'typescript-react';

/** File entry in the workspace index */
export interface FileEntry {
  readonly uri: Uri;
  readonly extension: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly projectRoot: Uri;
  readonly owningProviderId?: string;
  readonly lastScannedMs?: number;
  readonly lastDiagnosticsMs?: number;
}

/** Provider status change event */
export interface ProviderStatusChangeEvent {
  readonly providerId: string;
  readonly status: ProviderStatus;
}

/** Scan job completion event (providerId records which provider actually ran) */
export interface ScanJobCompleteEvent {
  readonly job: ScanJob;
  readonly providerId: string;
  readonly result: ScanResult;
}

/** Scan job failure event */
export interface ScanJobFailedEvent {
  readonly job: ScanJob;
  readonly providerId: string;
  readonly error: Error;
}

/** Queue overflow: a job was dropped because the queue hit its bound (§7.4.5) */
export interface ScanQueueOverflowEvent {
  readonly job: ScanJob;
}

/** Scan activity snapshot for consumers (idle/scanning, running + queued counts) */
export interface ScanStateEvent {
  readonly phase: 'idle' | 'scanning';
  readonly running: number;
  readonly queued: number;
}

/** Public alias — DiagnosticsAPI's `onProblemsChanged` payload (§5.7) */
export type ProblemChangeEvent = DiagnosticsChangedEvent;

/** A single problem report produced by a provider for one file (line/column 0-based) */
export interface Diagnostic {
  readonly line: number;
  readonly column: number;
  readonly severity: ProblemSeverity;
  readonly message: string;
  /** e.g. 'tsc', 'ESLint:no-unused-vars', 'ruff:E501' */
  readonly source: string;
  readonly code?: string;
}

/** Read model returned by ProblemStore queries (alias of ProblemState) */
export type ProblemSummary = ProblemState;

/** Running totals across the whole store */
export interface ProblemTotals {
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
}

/** A file change detected by the WorkspaceIndex */
export interface FileChange {
  readonly kind: 'add' | 'change' | 'remove';
  readonly uri: Uri;
  readonly size?: number;
  readonly modifiedMs?: number;
}

/** File change batch emitted by the WorkspaceIndex */
export interface FileChangeEvent {
  readonly changes: readonly FileChange[];
}

/** Fired when a provider's diagnostics for a file were applied to the store */
export interface DiagnosticsChangedEvent {
  readonly uri: Uri;
  readonly providerId: string;
  readonly diagnostics: readonly Diagnostic[];
}

/** Fired when running totals changed */
export interface TotalsChangedEvent {
  readonly totals: ProblemTotals;
}

/** Fired when the current owner of a path changed */
export interface OwnershipChangedEvent {
  readonly uri: Uri;
  readonly providerId: string | undefined;
  readonly previousProviderId: string | undefined;
}

/** Provider configuration object (validated against the provider's configSchema) */
export type ProviderConfig = Record<string, unknown>;

/** Result of a health check (§11.2) */
export interface HealthResult {
  readonly health: ProviderHealth;
  readonly message?: string;
}

/**
 * The provider contract. Lives in @pe/core because both the scheduler and the
 * public API depend on it; @pe/provider-sdk re-exports it for authors (§12).
 */
export interface Provider {
  /** Unique, kebab-case: 'tsc', 'eslint', 'ruff' */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  /** JSON Schema validated via @pe/core config utilities */
  readonly configSchema: Schema;
  readonly defaultConfig: ProviderConfig;
  healthCheck(): Promise<HealthResult>;
  /** Receives URIs — never walks the filesystem (§6.4) */
  scan(context: ScanContext): Promise<ScanResult>;
  dispose?(): void;
}

/** Engine-wide tuning knobs (all optional; defaults per §7.4/§8) */
export interface EngineConfig {
  /** Per-file save debounce window (default 300ms). */
  readonly debounceMs?: number;
  /** Global batch flush window (default 500ms). */
  readonly batchMs?: number;
  /** Periodic jobs run only if no job finished within this window (default 5000ms). */
  readonly idleWindowMs?: number;
  /** Scheduler queue bound (default 100). */
  readonly queueSize?: number;
  /** Per-scan timeout (default 30000ms). */
  readonly scanTimeoutMs?: number;
  /** Concurrency slots per cost class (default cheap 4, medium 2, expensive 1). */
  readonly maxConcurrency?: Partial<Record<Cost, number>>;
}
