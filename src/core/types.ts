/** Ordering matches worst-severity-wins: None < Info < Warning < Error */
export enum ProblemSeverity {
  None = 0,
  Info = 1,
  Warning = 2,
  Error = 3,
}

/** Immutable value object representing the diagnostics summary for one file or folder */
export interface ProblemState {
  readonly severity: ProblemSeverity;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly infoCount: number;
  /** Number of files contributing to this state (1 for a single file, aggregated for folders) */
  readonly fileCount: number;
}

export interface TscConfig {
  readonly enabled: boolean;
  readonly autoScan: boolean;
  readonly scanOnStartup: boolean;
  readonly timeout: number;
  readonly useWorkspaceVersion: boolean;
  readonly maxConcurrentScans: number;
}

export interface EslintConfig {
  readonly enabled: boolean;
  readonly autoScan: boolean;
  readonly timeout: number;
  readonly maxConcurrentScans: number;
}

/**
 * Unified configuration shape that every provider SHOULD expose. The common
 * fields give the registry a generic dispatch surface; provider-specific fields
 * live on the concrete config interfaces (TscConfig, EslintConfig, etc.).
 *
 * Each provider's descriptor declares a `configSection` string (e.g.
 * 'typescript', 'eslint') so the registry can read its section generically.
 */
export interface ProviderConfig {
  /** Master switch for this provider. When false, no scans run and ownership
   * is released so vscodeDiagnostics can take over. */
  readonly enabled: boolean;
  /** Whether this provider participates in save-triggered auto-scans. */
  readonly autoScan: boolean;
  /** Whether this provider runs a scan at extension startup. */
  readonly scanOnStartup: boolean;
  /** Max time in ms for a single scan before it's killed. */
  readonly timeout: number;
  /** Max concurrent scan processes for this provider. */
  readonly maxConcurrentScans: number;
}

export interface Config {
  readonly enabled: boolean;
  readonly showWarnings: boolean;
  readonly badgeStyle: 'letter' | 'count' | 'dot' | 'none';
  readonly ignorePatterns: string[];
  readonly errorColor: string | undefined;
  readonly warningColor: string | undefined;
  readonly infoColor: string | undefined;
  /**
   * Per-file-extension severity overrides.
   * Keys are file extensions (e.g. ".py"), values map source severity names to target severity names.
   * Example: `{ ".py": { "Error": "Warning" } }` demotes Python errors to warnings.
   */
  readonly severityOverrides: Record<string, Record<string, string>> | undefined;
  readonly autoScanEnabled: boolean;
  readonly autoScanDelay: number;
  readonly debug: boolean;
  /**
   * Interval (ms) at which `vscodeDiagnostics` reconciles its tracked URIs
   * against VS Code's current diagnostic snapshot, clearing stale badges for
   * files whose problems have disappeared (e.g. fixed by external formatters
   * or branch switches). 0 disables periodic reconciliation; only the
   * save-driven path remains. Default: 30000.
   */
  readonly reconcileIntervalMs: number;
  /** Per-provider provider config sections (typed for known providers). */
  readonly typescript: TscConfig;
  readonly eslint: EslintConfig;
  /**
   * Generic per-provider config map — key is the provider id (matching its
   * descriptor.id and configSection). Used by the registry to dispatch config
   * changes to providers generically. For the existing typescript/eslint
   * providers, the entries are also available via the typed `Config.typescript`
   * and `Config.eslint` fields above (same data, two access paths for
   * back-compat). New providers should be read ONLY from this map.
   */
  readonly providers: Record<string, ProviderConfig>;
}

/**
 * Declares what a provider supports so the AutoScanController can match
 * file-save events to providers without knowing provider names.
 *
 * - `extensions`: file extensions this provider can scan (e.g. ['.ts','.tsx'])
 * - `realtime`: provider receives diagnostics automatically (language server, VS Code API)
 * - `manualScan`: provider should be triggered on file save/change events
 * - `startupScan`: provider should run at extension startup
 * - `fullWorkspace`: provider can scan all files (not just the saved one)
 */
export interface ProviderCapabilities {
  readonly extensions: readonly string[];
  readonly realtime?: boolean;
  readonly manualScan?: boolean;
  readonly startupScan?: boolean;
  readonly fullWorkspace?: boolean;
}

/** Convenience type for badge formatting — just the counts, no severity */
export type SeverityCounts = Pick<ProblemState, 'errorCount' | 'warningCount' | 'infoCount'>;

/**
 * Scan progress phase for a single provider.
 * - `resolving`: discovering projects/configs to scan
 * - `scanning`: running the tool (tsc, eslint, etc.)
 * - `parsing`: parsing tool output
 * - `writing`: writing results to the store
 * - `completed`: scan finished successfully
 * - `cancelled`: scan was aborted
 * - `error`: scan failed
 */
export type ScanPhase = 'resolving' | 'scanning' | 'parsing' | 'writing' | 'completed' | 'cancelled' | 'error';

export interface ScanProgress {
  readonly providerName: string;
  readonly phase: ScanPhase;
  readonly message?: string;
  readonly detail?: string;
}
