import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // DB/Redis-backed tests share one database, so files must not run in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://surveyflow:surveyflow@127.0.0.1:5432/surveyflow_test',
      REDIS_URL: 'redis://127.0.0.1:6379/9',
      WHATSAPP_MODE: 'mock',
      PSP_MOCK: 'true',
      GIFT_PROVIDER: 'mock',
      META_APP_SECRET: 'test-app-secret',
      WHATSAPP_VERIFY_TOKEN: 'test-verify-token',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234567890',
      RUN_JOBS: 'false',
      FLUTTERWAVE_SECRET_KEY: 'FLWSECK_TEST',
      FLUTTERWAVE_WEBHOOK_HASH: 'flw-hash-123',
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      GOOGLE_REDIRECT_URI: 'http://localhost:4222/integrations/google/callback',
      PUPPETEER_EXECUTABLE_PATH: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    },
  },
});
