import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

function shellArg(value: string): string {
  return process.platform === 'win32' ? JSON.stringify(value) : value;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');

  // The nearest package.json says "type": "module", but the dist test output
  // (and what the extension host require()s) is CommonJS — scope it back.
  fs.writeFileSync(
    path.join(__dirname, 'package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2),
  );

  // Scaffold a workspace with a broken TypeScript file before the extension
  // host starts so the engine's workspace root exists at activation.
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-workspace-'));
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
  fs.writeFileSync(path.join(srcDir, 'clean.ts'), 'export const ok: number = 42;\n');
  // Ruff owns .py once registered: broken.py must surface an F821 without
  // anyone opening the file.
  fs.writeFileSync(path.join(srcDir, 'broken.py'), 'print(undefined_variable)\n');
  fs.writeFileSync(path.join(srcDir, 'app.py'), 'def greet():\n    return "hello"\n');
  // .txt is not scanner-owned: realtime diagnostics own it in the smoke.
  fs.writeFileSync(path.join(srcDir, 'notes.txt'), 'plain text\n');

  try {
    await runTests({
      extensionDevelopmentPath: shellArg(extensionDevelopmentPath),
      extensionTestsPath: shellArg(extensionTestsPath),
      launchArgs: [fixtureRoot],
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main();