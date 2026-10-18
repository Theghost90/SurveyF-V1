import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/** PDF tests need a real Chrome. Honour the developer's own path, else the sandbox's Chromium if it exists, else let Puppeteer use the browser it downloaded. */
function chromePath(): string {
  const linuxSandbox = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  return process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(linuxSandbox) ? linuxSandbox : '');
}

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
      PUPPETEER_EXECUTABLE_PATH: chromePath(),
      // Hermetic: a developer's own .env or shell must never leak into the tests (a real INTERNAL_API_SECRET makes every call 403,
      // real PSP keys change which providers exist). Empty = "not configured".
      INTERNAL_API_SECRET: '',
      NEXTAUTH_SECRET: '',
      TOKEN_ENCRYPTION_KEY: '',
      WHATSAPP_PHONE_NUMBER_ID: '',
      WHATSAPP_ACCESS_TOKEN: '',
      WHATSAPP_BUSINESS_ACCOUNT_ID: '',
      META_APP_ID: '',
      META_EMBEDDED_SIGNUP_CONFIG_ID: '',
      NOTCHPAY_API_KEY: '',
      NOTCHPAY_WEBHOOK_HASH: '',
      CINETPAY_API_KEY: '',
      CINETPAY_SITE_ID: '',
      CINETPAY_SECRET_KEY: '',
      CAMPAY_API_KEY: '',
      CAMPAY_APP_ID: '',
      CAMPAY_WEBHOOK_KEY: '',
      PAYUNIT_API_KEY: '',
      PAYUNIT_API_USERNAME: '',
      PAYUNIT_API_PASSWORD: '',
      CAMERPAY_API_KEY: '',
      CAMERPAY_WEBHOOK_SECRET: '',
      PSP_FEES: '',
      DEV_GEO_COUNTRY: '',
    },
  },
});
