import { workspace, languages, Uri } from 'vscode';
import type { Experiment } from '../runner';
import { log } from '../runner';

/**
 * Experiment: does calling workspace.openTextDocument(uri) trigger VS Code
 * to compute diagnostics for that file?
 *
 * Hypothesis (REVIEW.md Bug #5): VS Code only computes diagnostics for
 * files that have been opened at least once. If the extension never opens
 * a document, it may never receive onDidChangeDiagnostics events, and
 * therefore never populate ProblemStore for that document.
 *
 * Procedure:
 *   1. Pick a .ts file from the workspace
 *   2. Call workspace.openTextDocument(uri) — loads into memory, no editor tab
 *   3. Wait 2 seconds for diagnostics engine to settle
 *   4. Call languages.getDiagnostics(uri)
 *   5. PASS if diagnostics.length > 0 (diagnostics appeared after open)
 *   6. FAIL if diagnostics.length === 0 (opening didn't trigger diagnostics)
 */
export const openTextDocumentExperiment: Experiment = async () => {
  const files = await workspace.findFiles('**/*.ts', '**/node_modules/**');
  log(`Found ${files.length} .ts files in workspace`);

  if (files.length === 0) {
    return {
      name: 'openTextDocument: triggers diagnostics',
      passed: false,
      message: 'No .ts files found in workspace — cannot run experiment',
      durationMs: 0,
    };
  }

  // Use the first .ts file found
  const target = files[0];
  log(`Selected file: ${target.toString()}`);

  // Check diagnostics BEFORE opening
  const before = languages.getDiagnostics(target);
  log(`Diagnostics before openTextDocument: ${before.length}`);

  // Open the document in memory (no editor tab)
  const doc = await workspace.openTextDocument(target);
  log(`Opened document: ${doc.uri.toString()} (languageId=${doc.languageId})`);

  // Wait 2 seconds for diagnostics engine
  log('Waiting 2 seconds for diagnostics to settle...');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Check diagnostics AFTER opening
  const after = languages.getDiagnostics(target);
  log(`Diagnostics after openTextDocument: ${after.length}`);

  if (after.length > 0) {
    return {
      name: 'openTextDocument: triggers diagnostics',
      passed: true,
      message: `Diagnostics appeared after openTextDocument: ${before.length} → ${after.length}`,
      durationMs: 0,
    };
  }

  return {
    name: 'openTextDocument: triggers diagnostics',
    passed: false,
    message: `No diagnostics after opening document (before=${before.length}, after=${after.length})`,
    durationMs: 0,
  };
};
