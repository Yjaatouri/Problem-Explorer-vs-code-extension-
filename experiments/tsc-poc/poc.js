/**
 * tsc --noEmit — Proof of Concept
 *
 * Usage: node poc.js <project-dir>
 *
 * Steps:
 *   1. Resolve tsc.js from project node_modules (or VS Code bundled)
 *   2. Run `node tsc.js --noEmit --pretty false --project tsconfig.json`
 *   3. Capture stdout + stderr
 *   4. Parse diagnostic lines
 *   5. Print results
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── 1. Resolve tsc.js ────────────────────────────────────────────────
function resolveTsc(projectDir) {
  const local = path.join(projectDir, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (fs.existsSync(local)) return local;
  const vscodeBundled = path.join(
    process.env.VSCODE_PATH || '',
    'extensions', 'node_modules', 'typescript', 'lib', 'tsc.js'
  );
  if (fs.existsSync(vscodeBundled)) return vscodeBundled;
  // Fallback: try global
  try {
    return require.resolve('typescript/lib/tsc.js');
  } catch {
    return null;
  }
}

// ── 2. Find tsconfig ─────────────────────────────────────────────────
function findTsconfig(projectDir) {
  const candidates = ['tsconfig.json', 'tsconfig.test.json'];
  for (const name of candidates) {
    const p = path.join(projectDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── 3. Run tsc ───────────────────────────────────────────────────────
function runTsc(tscScript, tsconfigPath, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const args = [tscScript, '--noEmit', '--pretty', 'false', '--project', tsconfigPath];
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdout = [];
    const stderr = [];
    const start = Date.now();

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: null, stdout: stdout.join(''), stderr: stderr.join(''), timedOut: true });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: stdout.join(''), stderr: stderr.join(''), error: err.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: stdout.join(''), stderr: stderr.join('') });
    });
  });
}

// ── 4. Parse diagnostic lines ────────────────────────────────────────
const DIAG_RE = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

function parseOutput(text) {
  const results = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DIAG_RE.exec(line.trim());
    if (!m) continue;
    results.push({
      file: m[1],
      line: parseInt(m[2], 10),
      column: parseInt(m[3], 10),
      severity: m[4],
      code: m[5],
      message: m[6],
    });
  }
  return results;
}

// ── 5. Print results ─────────────────────────────────────────────────
function printResults(diagnostics, meta) {
  if (diagnostics.length === 0) {
    console.log('No diagnostics found. tsc completed with no errors.');
    return;
  }

  const byFile = {};
  for (const d of diagnostics) {
    if (!byFile[d.file]) byFile[d.file] = [];
    byFile[d.file].push(d);
  }

  const fileNames = Object.keys(byFile).sort();
  console.log(`\nParsed ${diagnostics.length} diagnostic(s) across ${fileNames.length} file(s):\n`);

  for (const file of fileNames) {
    console.log(`  ${file}`);
    for (const d of byFile[file]) {
      console.log(`    Line ${d.line}:${d.column}  ${d.severity.toUpperCase()}  ${d.code}  ${d.message}`);
    }
    console.log('');
  }

  const errors = diagnostics.filter(d => d.severity === 'error').length;
  const warnings = diagnostics.filter(d => d.severity === 'warning').length;
  console.log(`Summary: ${errors} error(s), ${warnings} warning(s)`);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const projectDir = process.argv[2] || process.cwd();
  console.log(`\n=== tsc --noEmit POC ===`);
  console.log(`Project: ${projectDir}\n`);

  const tscScript = resolveTsc(projectDir);
  if (!tscScript) {
    console.error('ERROR: Could not resolve tsc.js. Install TypeScript or set VSCODE_PATH.');
    process.exit(1);
  }
  console.log(`tsc.js:   ${tscScript}`);

  const tsconfig = findTsconfig(projectDir);
  if (!tsconfig) {
    console.error('ERROR: No tsconfig.json found in project.');
    process.exit(1);
  }
  console.log(`tsconfig: ${tsconfig}\n`);

  console.log('Running tsc --noEmit...');
  const result = await runTsc(tscScript, tsconfig);

  if (result.timedOut) {
    console.error('ERROR: tsc timed out.');
    process.exit(1);
  }
  if (result.error) {
    console.error(`ERROR: spawn failed — ${result.error}`);
    process.exit(1);
  }

  console.log(`Exit code: ${result.exitCode}`);
  console.log(`Time:      ${result.executionTimeMs || '(not measured)'}ms`);
  console.log(`stdout:    ${result.stdout.length} chars`);
  console.log(`stderr:    ${result.stderr.length} chars\n`);

  // Parse the full combined output
  const diagnostics = parseOutput(result.stderr + '\n' + result.stdout);
  printResults(diagnostics, result);

  console.log('\n=== POC complete ===');
}

main().catch(err => { console.error(err); process.exit(1); });
