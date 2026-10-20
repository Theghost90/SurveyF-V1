import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // The shared package ships TypeScript source, so it must be bundled.
  noExternal: ['@surveyflow/shared'],
});
