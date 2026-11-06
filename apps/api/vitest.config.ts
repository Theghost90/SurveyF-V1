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
      ENCRYPTION_KEYS: '',
      BLIND_INDEX_KEY: '',
      JWT_SECRET_PREVIOUS: '',
      // Sign-in security, hermetic: mail goes to the in-memory mailbox, no CAPTCHA, no network password check, cheap hashes (the default cost is tested directly).
      EMAIL_PROVIDER: 'mock',
      EMAIL_FROM: 'SurveyFlow <no-reply@surveyflow.local>',
      PUBLIC_WEB_URL: 'http://localhost:4222',
      SMTP_URL: '',
      RESEND_API_KEY: '',
      BREVO_API_KEY: '',
      TURNSTILE_SITE_KEY: '',
      TURNSTILE_SECRET_KEY: '',
      CAPTCHA_DISABLED: '',
      HIBP_CHECK: 'false',
      AUTH_MIN_RESPONSE_MS: '0', // the padding has its own test; everywhere else it would only slow the suite down
      ARGON2_MEMORY_KIB: '1024',
      ARGON2_TIME_COST: '1',
      ACCESS_TOKEN_TTL_SECONDS: '900',
      RATE_LIMIT_IP_PER_MINUTE: '1000000', // the per-address ceiling has its own test (it lowers the value); the whole suite is one address
      REQUIRE_2FA_PLANS: 'business',
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
      // Hermetic, second part: every number the code reads from the environment is pinned to its documented default, so a developer's own .env (a payout hold for a pilot,
      // lower caps, a shorter session) cannot change what a test sees. Found on 5 November 2026: PAYOUT_HOLD_DAYS or lowered payout caps in a .env made 6 gift and wallet tests fail.
      PAYOUT_HOLD_DAYS: '0', PAYOUT_ACCOUNT_MAX_XAF_PER_DAY: '100000', PAYOUT_PHONE_MAX_XAF_PER_DAY: '5000', PAYOUT_PHONE_MAX_COUNT_PER_DAY: '3', GIFT_FEE_PERCENT: '5',
      SESSION_TTL_HOURS: '12', SESSION_TIMEOUT_HOURS: '24', EXPORT_DAILY_LIMIT: '20', EXPORT_DAILY_ROWS: '50000', STEP_UP_EXPORT_ROWS: '50', STEP_UP_BULK_ROWS: '20', STEP_UP_MINUTES: '15',
      REVEAL_PER_DAY: '300', READ_SOFT_PEOPLE: '1000', READ_HARD_PEOPLE: '20000', SHEETS_AUTOSYNC_DAYS: '30', AUDIT_RETENTION_DAYS: '400', ACCOUNT_DELETION_GRACE_DAYS: '30',
      PRORATION_ENABLED: 'true', OVERAGE_DUE_DAYS: '14', OVERAGE_BLOCK_SENDS_AFTER_DAYS: '0', FINANCIAL_RETENTION_YEARS: '10', ACCOUNT_EXPORT_PER_DAY: '3', UNVERIFIED_PURGE_HOURS: '24',
      SIGNUP_PER_IP_HOUR: '30', RATE_LIMIT_SESSION_PER_MINUTE: '300', META_GRAPH_VERSION: 'v22.0', CAMPAY_ENV: 'demo', PAYUNIT_MODE: 'test', CAMERPAY_PLAN: 'starter',
      FX_CACHE_MINUTES: '360', FX_MAX_STALE_HOURS: '72', RECONCILE_MIN_SHORTFALL_XAF: '5000', RECONCILE_MIN_SHORTFALL_PERCENT: '2', RECONCILE_BALANCE_MAX_AGE_HOURS: '48',
      BALANCE_SOURCES: '', TEAM_INVITE_DAYS: '7', WHATSAPP_PLATFORM_PHONE: '',
    },
  },
});
