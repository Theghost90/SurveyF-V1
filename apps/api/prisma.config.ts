import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 reads its settings from this file and no longer loads a .env by itself. The repository has ONE .env at its root that serves every app and every
 * command (db push, migrate deploy, seed, the API, the tests), so it is loaded here, without overriding variables that are already set.
 */
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Only the commands that talk to the database (db push, migrate deploy) need it; `prisma generate` runs without one (Docker builds, npm install).
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
