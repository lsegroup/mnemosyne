import { build, context } from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
};

if (process.argv.includes('--watch')) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log('esbuild: watching');
} else {
  await build(opts);
}
