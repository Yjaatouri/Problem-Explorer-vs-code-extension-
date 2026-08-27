/**
 * Fetch all supported @oxlint/binding-* platform binaries for the oxlint
 * version pinned in package.json, extracting them into node_modules/@oxlint.
 *
 * npm cannot install cross-platform binaries on its own (it skips packages
 * whose os/cpu don't match the host), so bundling all bindings into the VSIX
 * requires fetching the tarballs directly. Idempotent: skips bindings whose
 * .node artifact already exists.
 *
 * Usage: node scripts/fetch-oxlint-bindings.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const oxlintVersion = (pkg.dependencies?.oxlint ?? pkg.devDependencies?.oxlint ?? '').replace(/^[\^~]/, '');
if (!oxlintVersion) {
  console.error('oxlint not found in package.json dependencies');
  process.exit(1);
}

/** VS Code desktop platforms we support (win/mac/linux × x64/arm64, glibc+musl). */
const BINDINGS = [
  'binding-win32-x64-msvc',
  'binding-win32-arm64-msvc',
  'binding-darwin-x64',
  'binding-darwin-arm64',
  'binding-linux-x64-gnu',
  'binding-linux-x64-musl',
  'binding-linux-arm64-gnu',
  'binding-linux-arm64-musl',
];

const oxlintScopeDir = path.join(repoRoot, 'node_modules', '@oxlint');
const tmp = path.join(tmpdir(), `oxlint-bindings-${process.pid}`);
mkdirSync(tmp, { recursive: true });

let fetched = 0;
let skipped = 0;

for (const name of BINDINGS) {
  const pkgDir = path.join(oxlintScopeDir, name);
  // A binding package ships exactly one .node artifact; presence = complete.
  if (existsSync(pkgDir) && readdirSync(pkgDir).some((f) => f.endsWith('.node'))) {
    console.log(`skip  ${name} (already present)`);
    skipped++;
    continue;
  }

  console.log(`fetch ${name}@${oxlintVersion}`);
  // Use powershell to run npm pack because npm is a PowerShell shim on Windows.
  const packResult = execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `npm pack @oxlint/${name}@${oxlintVersion} --pack-destination "${tmp}"`
  ], { encoding: 'utf8' });
  const tarball = packResult.trim().split('\n').pop().trim(); // last line is the tarball filename
  const unpacked = path.join(tmp, name);
  mkdirSync(unpacked, { recursive: true });
  execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', unpacked]);
  rmSync(pkgDir, { recursive: true, force: true });
  mkdirSync(path.dirname(pkgDir), { recursive: true });
  renameSync(path.join(unpacked, 'package'), pkgDir);
  fetched++;
}

console.log(`\nDone: ${fetched} fetched, ${skipped} already present.`);
rmSync(tmp, { recursive: true, force: true });