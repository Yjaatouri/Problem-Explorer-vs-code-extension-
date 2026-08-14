import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

function shellArg(value: string): string {
  return process.platform === 'win32' ? JSON.stringify(value) : value;
}

/**
 * Realtime smoke runner. DELIBERATELY does NOT touch PATH (unlike
 * runTest.ts, which prepends node_modules/.bin): this host must see NO
 * tsc/eslint/ruff on PATH so the realtime provider is the only owner for
 * .ts files — the environment the extension actually runs in on Windows
 * (the ext host inherits the registry PATH, not the shell's).
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');

  // The nearest package.json says "type": "module", but the dist test output
  // (and what the extension host require()s) is CommonJS — scope it back.
  fs.writeFileSync(
    path.join(__dirname, 'package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2),
  );

  // Scaffold a workspace with an existing broken TypeScript file before the
  // extension host starts, so the engine's workspace root exists at
  // activation. The file is never opened by the suite — diagnostics are
  // injected via a DiagnosticCollection instead.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-realtime-'));
  const srcDir = path.join(fixtureRoot, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', noEmit: true },
      files: ['src/broken.ts'],
    }),
  );
  fs.writeFileSync(path.join(srcDir, 'broken.ts'), "const value: number = 'not-a-number';\n");

  try {
    await runTests({
      extensionDevelopmentPath: shellArg(extensionDevelopmentPath),
      extensionTestsPath: shellArg(extensionTestsPath),
      launchArgs: [fixtureRoot],
    });
  } catch (err) {
    console.error('Failed to run realtime tests:', err);
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn('Could not remove fixture dir (VS Code still holds it on Windows):', err);
    }
  }
}

main();