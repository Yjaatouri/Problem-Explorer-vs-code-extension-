import { runExperiments } from './runner';
import { uriNormalizationExperiment } from './experiments/uriNormalization';
import { openTextDocumentExperiment } from './experiments/openTextDocument';

/**
 * Entry point for running all diagnostics experiments.
 *
 * Compile:  tsc -p experiments/diagnostics/tsconfig.json
 * Run:      node --require source-map-support/register out/experiments/experiments/diagnostics/main.js
 *
 * Must be executed inside VS Code's extension host
 * (or a Node environment with the vscode module available).
 */
export async function main(): Promise<void> {
  await runExperiments({
    uriNormalization: uriNormalizationExperiment,
    openTextDocument: openTextDocumentExperiment,
    // Add more experiments here as Task A1/A2 progresses:
    // provideFileDecoration: provideFileDecorationExperiment,
    // fireDidChange: fireDidChangeExperiment,
    // storeRoundTrip: storeRoundTripExperiment,
  });
}

main().catch((err) => {
  console.error('[diagnostics-experiment] Fatal error:', err);
  process.exit(1);
});
