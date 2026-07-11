import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {
  test('extension exports activate and deactivate', async () => {
    const ext = vscode.extensions.getExtension('Yjaatouri.problem-explorer');
    assert.ok(ext);
    assert.ok(ext.isActive);
    const api = ext.exports;
    assert.ok(api);
    assert.strictEqual(typeof api.getProblemStatus, 'function');
  });
});
