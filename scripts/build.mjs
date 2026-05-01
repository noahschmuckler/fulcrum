#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';

const watch = process.argv.includes('--watch');

await spawn('node', ['scripts/build-cases.mjs'], { stdio: 'inherit' });

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'public/js/main.js',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('esbuild watching...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
