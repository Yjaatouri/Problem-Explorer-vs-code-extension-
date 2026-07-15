import { Uri } from 'vscode';
import { ProblemState, ProblemSeverity } from '../../src/core/types';
import { normalizeUriKey } from '../../src/core/uriKey';
import { ProblemStore } from '../../src/store/ProblemStore';

export type ExperimentResult = {
  name: string;
  passed: boolean;
  message: string;
  durationMs: number;
};

export type Experiment = () => ExperimentResult | Promise<ExperimentResult>;

const results: ExperimentResult[] = [];
const logs: string[] = [];

export function log(message: string): void {
  const line = `[diagnostics-experiment] ${message}`;
  logs.push(line);
  console.log(line);
}

export function logState(label: string, state: ProblemState | undefined): void {
  if (state) {
    log(`${label}: severity=${ProblemSeverity[state.severity]}, errors=${state.errorCount}, warnings=${state.warningCount}, infos=${state.infoCount}, files=${state.fileCount}`);
  } else {
    log(`${label}: undefined`);
  }
}

export function logUri(label: string, uri: Uri): void {
  log(`${label}: ${uri.toString()} (key=${normalizeUriKey(uri)})`);
}

export async function runExperiments(experiments: Record<string, Experiment>): Promise<void> {
  log('=== Diagnostics Experiment Framework ===');
  log(`Started at ${new Date().toISOString()}`);

  for (const [name, experiment] of Object.entries(experiments)) {
    const start = Date.now();
    try {
      const result = await experiment();
      result.durationMs = Date.now() - start;
      results.push(result);
      log(`${result.passed ? 'PASS' : 'FAIL'} [${result.durationMs}ms] ${name}: ${result.message}`);
    } catch (err) {
      const durationMs = Date.now() - start;
      results.push({ name, passed: false, message: String(err), durationMs });
      log(`FAIL [${durationMs}ms] ${name}: ${err}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  log(`=== Done: ${passed} passed, ${failed} failed, ${results.length} total ===`);
}

export { ProblemStore, Uri };
export type { ProblemState };
