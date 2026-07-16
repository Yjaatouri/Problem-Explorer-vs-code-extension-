let logger: ((msg: string) => void) | undefined;

export function initForensicLogger(logFn: (msg: string) => void): void {
  logger = logFn;
}

export function forensicLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  logger?.(line);
  console.log(`[PE-FOR] ${line}`);
}

/** Chain-level forensic counters — each counter tracks one link in the auto-scan -> decoration pipeline */
export const chainCounters = {
  /** Step A: AutoScanner.onFileChanged matched a file extension */
  autoScannerTriggered: 0,
  /** Step A2: AutoScanner._flush() began executing for a provider */
  autoScannerFlushProviderRun: 0,
  /** Step B: provider.refresh() was entered */
  providerRefreshCalled: 0,
  /** Step C: provider.runScan() returned >=1 changed URIs */
  providerRunScanReturned: 0,
  /** Step C2: provider._onDidUpdate.fire() was called with changed URIs */
  providerOnDidUpdateFired: 0,
  /** Step D: DiagnosticProviderManager.onDidUpdate subscriber received the event */
  dpmOnDidUpdateReceived: 0,
  /** Step D1: DiagnosticProviderManager.onDidProgressScan subscriber received progress */
  dpmOnProgressReceived: 0,
  /** Step D2: VSDiagnosticsProvider.onDidUpdateAll subscriber received the event */
  vsDiagOnDidUpdateAllReceived: 0,
  /** Step E: VSDiagnosticsProvider.flushUpdates debounced function executed */
  vsDiagFlushUpdatesExecuted: 0,
  /** Step E2: folderStatusManager.updateAncestors returned >=1 changed ancestor URIs */
  updateAncestorsReturned: 0,
  /** Step F: decorationEngine.fireDidChange was called with a non-empty array */
  fireDidChangeWithUris: 0,
  /** Total auto-scan Flush calls (for correlation) */
  autoScannerFlushCalled: 0,
};

export function resetChainCounters(): void {
  for (const key of Object.keys(chainCounters) as (keyof typeof chainCounters)[]) {
    chainCounters[key] = 0;
  }
}

export function dumpChainReport(): string {
  const c = chainCounters;
  const lines = [
    `[CHAIN:REPORT] ===== CHAIN FORENSIC REPORT =====`,
    `[CHAIN:REPORT] AutoScanner.onFileChanged matched: ${c.autoScannerTriggered}`,
    `[CHAIN:REPORT] AutoScanner._flush called: ${c.autoScannerFlushCalled}`,
    `[CHAIN:REPORT] AutoScanner._flush provider.run(): ${c.autoScannerFlushProviderRun}`,
    `[CHAIN:REPORT] provider.refresh() entered: ${c.providerRefreshCalled}`,
    `[CHAIN:REPORT] provider.runScan() returned URIs: ${c.providerRunScanReturned}`,
    `[CHAIN:REPORT] provider._onDidUpdate.fire(): ${c.providerOnDidUpdateFired}`,
    `[CHAIN:REPORT] DPM onDidUpdate received: ${c.dpmOnDidUpdateReceived}`,
    `[CHAIN:REPORT] DPM onDidProgressScan received: ${c.dpmOnProgressReceived}`,
    `[CHAIN:REPORT] VSDiag onDidUpdateAll received: ${c.vsDiagOnDidUpdateAllReceived}`,
    `[CHAIN:REPORT] VSDiag flushUpdates executed: ${c.vsDiagFlushUpdatesExecuted}`,
    `[CHAIN:REPORT] updateAncestors returned URIs: ${c.updateAncestorsReturned}`,
    `[CHAIN:REPORT] fireDidChange called with URIs: ${c.fireDidChangeWithUris}`,
    `[CHAIN:REPORT] ===== END CHAIN REPORT =====`,
  ];
  return lines.join('\n');
}
