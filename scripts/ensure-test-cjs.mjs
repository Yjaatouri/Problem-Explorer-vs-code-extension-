import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The extension package is "type": "module", but the compiled test harness
// (dist/test) is CommonJS — tsc keeps .js extensions, so node must be told
// via a scoped package.json. Run before `node dist/test/runTest.js`.
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/extension/dist/test');
writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log(`wrote ${resolve(dir, 'package.json')}`);
