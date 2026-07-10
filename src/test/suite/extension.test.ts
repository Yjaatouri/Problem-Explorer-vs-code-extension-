import * as assert from 'assert';

suite('Extension', () => {
  test('extension exports activate and deactivate', () => {
    const ext = require('../../extension');
    assert.strictEqual(typeof ext.activate, 'function');
    assert.strictEqual(typeof ext.deactivate, 'function');
  });
});
