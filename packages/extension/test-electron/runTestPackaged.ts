import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { downloadAndUnzipVSCode, runTests, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';

import { execFileSync } from 'child_process';

function shellArg(value: string): string {
  return process.platform === 'win32' ? JSON.stringify(value) : value;
}

function installExtension(
  cliPath: string,
  vscodeExecutablePath: string,
  vsixPath: string,
  extensionsDir: string,
  userDataDir: string,
): void {
  // On Windows the resolved CLI is a bin/code.cmd shim. Its recipe is
  // ELECTRON_RUN_AS_NODE=1 Code.exe <runtime>/resources/app/out/cli.js <args>
  // — reproduce it so we don't need cmd.exe quoting gymnastics.
  let executable = cliPath;
  const args = [
    '--install-extension',
    vsixPath,
    '--extensions-dir',
    extensionsDir,
    '--user-data-dir',
    userDataDir,
    '--force',
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === 'win32') {
    const installDir = path.dirname(vscodeExecutablePath);
    // Layout: <installDir>/<commit-hash>/resources/app/out/cli.js
    const cliJs =
      fs
        .readdirSync(installDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(installDir, entry.name, 'resources', 'app', 'out', 'cli.js'))
        .find((probe) => fs.existsSync(probe)) ?? '';
    executable = cliJs ? path.join(installDir, 'Code.exe') : cliPath;
    if (cliJs) {
      args.unshift(cliJs);
      env.ELECTRON_RUN_AS_NODE = '1';
    }
  }
  execFileSync(executable, args, { stdio: 'inherit', env });
}

async function main(): Promise<void> {
  const extensionPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.js');
  const vsixPath = process.argv[2] ?? path.resolve(extensionPath, 'problem-explorer-2.0.0.vsix');
  if (!fs.existsSync(vsixPath)) {
    console.error(`VSIX not found at ${vsixPath} — run 'pnpm run package' first.`);
    process.exitCode = 1;
    return;
  }

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
  // No scanner owns .py here, so realtime ownership kicks in for the smoke.
  fs.writeFileSync(path.join(srcDir, 'app.py'), 'def greet():\n    return "hello"\n');

  // Isolated install: the packaged extension (exactly what users get) becomes
  // the one and only extension in the dev host. No extensionDevelopmentPath —
  // the suite resolves and activates the installed copy.
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-exts-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-userdata-'));
  // runTests requires --extensionDevelopmentPath, but it must not shadow the
  // installed vsix (same id would lose) — point it at an empty directory.
  const dummyDevPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-devpath-'));

  try {
    const vscodeExecutablePath = await downloadAndUnzipVSCode();
    const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);
    installExtension(cliPath, vscodeExecutablePath, vsixPath, extensionsDir, userDataDir);

    await runTests({
      extensionDevelopmentPath: shellArg(dummyDevPath),
      extensionTestsPath: shellArg(extensionTestsPath),
      launchArgs: [fixtureRoot, '--extensions-dir', extensionsDir, '--user-data-dir', userDataDir],
    });
  } catch (err) {
    console.error('Failed to run packaged tests:', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    fs.rmSync(extensionsDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(dummyDevPath, { recursive: true, force: true });
  }
}

main();