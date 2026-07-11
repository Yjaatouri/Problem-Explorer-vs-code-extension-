import * as path from 'path';

import { runTests } from '@vscode/test-electron';

/**
 * On Windows with `shell: true`, `@vscode/test-electron` concatenates
 * spawn args without escaping, so space-containing paths are split by
 * `cmd.exe`. We defensively JSON.stringify each path (`JSON.stringify`
 * wraps the value in double quotes) so that `cmd.exe` treats them as a
 * single token.
 */
function shellArg(value: string): string {
  if (process.platform === 'win32') {
    return JSON.stringify(value);
  }
  return value;
}

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(
      __dirname,
      './suite/index',
    );

    await runTests({
      extensionDevelopmentPath: shellArg(extensionDevelopmentPath),
      extensionTestsPath: shellArg(extensionTestsPath),
    });
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
