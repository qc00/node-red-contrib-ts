import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';

const outdir = '.test-build';
await rm(outdir, { recursive: true, force: true });
const entryPoints = (await readdir('test')).filter(name => name.endsWith('.test.ts')).map(name => `test/${name}`);

await build({
  entryPoints,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outdir,
  external: ['typescript', 'typescript/*', 'typescript5', '@types/node/package.json'],
  sourcemap: 'inline',
});
