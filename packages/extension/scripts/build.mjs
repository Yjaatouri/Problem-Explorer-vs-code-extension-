// Bundle the VS Code extension host entry. `vscode` is provided by the host.
import { build, context } from 'esbuild';

const watchMode = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.cjs',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info',
};

if (watchMode) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('esbuild: watching src/ for changes...');
  process.stdin.resume();
} else {
  await build(options);
}