import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts'], // the API and, optionally, the background jobs on their own (OPS-05)
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // The shared package ships TypeScript source, so it must be bundled.
  noExternal: ['@surveyflow/shared'],
});
