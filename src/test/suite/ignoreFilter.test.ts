import * as assert from 'assert';
import { Uri } from 'vscode';
import { isIgnored } from '../../performance/ignoreFilter';

suite('IgnoreFilter', () => {
  function u(path: string): Uri {
    return Uri.file(path);
  }

  test('node_modules is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/node_modules/foo/bar.js')), true);
  });

  test('.git is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/.git/objects/abc')), true);
  });

  test('dist is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/dist/bundle.js')), true);
  });

  test('build is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/build/output.exe')), true);
  });

  test('.next is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/.next/server/pages/index.js')), true);
  });

  test('target is ignored (Rust)', () => {
    assert.strictEqual(isIgnored(u('/workspace/target/debug/app')), true);
  });

  test('__pycache__ is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/src/__pycache__/foo.cpython-311.pyc')), true);
  });

  test('vendor is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/vendor/bundle.js')), true);
  });

  test('.tox is ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/.tox/py39/bin/pytest')), true);
  });

  test('source files are NOT ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/src/index.ts')), false);
    assert.strictEqual(isIgnored(u('/workspace/src/app.tsx')), false);
    assert.strictEqual(isIgnored(u('/workspace/src/utils/helper.ts')), false);
  });

  test('nested source files in lib are NOT ignored', () => {
    assert.strictEqual(isIgnored(u('/workspace/lib/main.js')), false);
  });

  test('empty patterns list ignores nothing', () => {
    assert.strictEqual(isIgnored(u('/workspace/node_modules/foo.js'), []), false);
  });

  test('custom patterns override defaults', () => {
    assert.strictEqual(isIgnored(u('/workspace/node_modules/foo.js'), []), false);
    assert.strictEqual(isIgnored(u('/workspace/src/custom.out'), ['**/*.out']), true);
  });

  test('custom pattern can match source files', () => {
    assert.strictEqual(isIgnored(u('/workspace/src/file.js'), ['**/src/**']), true);
  });

  test('dot option matches hidden files', () => {
    assert.strictEqual(isIgnored(u('/workspace/.secret/config')), false);
    assert.strictEqual(isIgnored(u('/workspace/.secret/config'), ['**/.*/**']), true);
  });

  test('Windows backslash paths are normalized', () => {
    const winUri = Uri.file('C:\\project\\node_modules\\pkg\\index.js');
    assert.strictEqual(isIgnored(winUri), true);
  });

  test('Windows normal source files NOT ignored', () => {
    const winUri = Uri.file('C:\\project\\src\\app.ts');
    assert.strictEqual(isIgnored(winUri), false);
  });

  test('root-level node_modules file is ignored', () => {
    assert.strictEqual(isIgnored(u('/node_modules/foo.js')), true);
  });

  test('deeply nested node_modules is ignored', () => {
    assert.strictEqual(isIgnored(u('/a/b/c/node_modules/d/e/f/index.js')), true);
  });

  test('dist with extra extension is ignored', () => {
    assert.strictEqual(isIgnored(u('/project/dist.min/file.js')), false); // not dist/, it's dist.min/
    assert.strictEqual(isIgnored(u('/project/dist/file.min.js')), true);  // dist/
  });

  test('sibling dist-like dirs are not ignored', () => {
    assert.strictEqual(isIgnored(u('/project/distribution/file.js')), false);
  });
});
