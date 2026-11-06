import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      // Fixed here so that a developer's own .env or shell never changes what the tests see.
      NEXTAUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
      NEXTAUTH_URL: 'http://localhost:4222',
      API_URL: 'http://api.test',
      INTERNAL_API_SECRET: 'test-internal-secret',
      CLIENT_IP_HEADER: '',
      TRUSTED_PROXY_HOPS: '',
    },
  },
});
