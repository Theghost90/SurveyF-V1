import { z } from 'zod';
import { documentedFees, type CamerpayPlan, type PspFee, type PspFees } from '@surveyflow/shared';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/**
 * Provider fees used to pick the cheapest PSP: the contract-fee document's numbers (shared/psp-fees.ts) overridden by PSP_FEES
 * (JSON, per provider and method: a number = percent, or {percent, fixed, fixedCurrency}). Your negotiated rates win.
 */
function parsePspFees(raw: string | undefined, camerpayPlan: CamerpayPlan): PspFees {
  const fees: PspFees = documentedFees(camerpayPlan);
  if (!raw) return fees;
  try {
    const v = JSON.parse(raw) as Record<string, Record<string, number | PspFee>>;
    for (const [psp, methods] of Object.entries(v ?? {})) {
      for (const [method, f] of Object.entries(methods ?? {})) {
        const fee: PspFee | null = typeof f === 'number' ? { percent: f } : f && typeof f.percent === 'number' ? f : null;
        if (!fee || !(fee.percent >= 0)) { console.error(`PSP_FEES: ignoring ${psp}.${method} (not a percent)`); continue; }
        (fees as Record<string, Record<string, PspFee>>)[psp] = { ...((fees as Record<string, Record<string, PspFee>>)[psp] ?? {}), [method]: fee };
      }
    }
  } catch {
    console.error('PSP_FEES is not valid JSON; using the documented fees');
  }
  return fees;
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4223),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  /** Browser origin(s) allowed by CORS, comma-separated. */
  WEB_ORIGIN: z.string().default('http://localhost:4222'),
  /** Public base URL of this API (used to build PSP webhook URLs). */
  PUBLIC_API_URL: z.string().default('http://localhost:4223'),

  // --- auth / secrets (additions to the spec's variable list) ---
  JWT_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(), // 32 bytes, base64 or hex
  INTERNAL_API_SECRET: z.string().optional(), // shared secret of the website's server: the API refuses every non-public call without it (also Google sign-in)

  // --- WhatsApp ---
  WHATSAPP_MODE: z.enum(['mock', 'live']).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
  /** SurveyFlow's own WhatsApp number as people dial it (digits with country code, e.g. 2376XXXXXXXX): where owners link their phone and ask the Analytics Bot. */
  WHATSAPP_PLATFORM_PHONE: z.string().regex(/^\d{8,15}$/, 'digits only, with country code').optional(),
  META_APP_SECRET: z.string().optional(), // REQUIRED to verify webhook signatures
  META_APP_ID: z.string().optional(),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v22.0'),
  SESSION_TIMEOUT_HOURS: z.coerce.number().default(24),

  // --- PSPs ---
  PSP_MOCK: bool, // dev/demo checkout; refused in production
  NOTCHPAY_API_KEY: z.string().optional(),
  NOTCHPAY_WEBHOOK_HASH: z.string().optional(),
  CINETPAY_API_KEY: z.string().optional(),
  CINETPAY_SITE_ID: z.string().optional(),
  CINETPAY_SECRET_KEY: z.string().optional(),
  CAMPAY_API_KEY: z.string().optional(),
  CAMPAY_APP_ID: z.string().optional(),
  CAMPAY_ENV: z.enum(['demo', 'prod']).default('demo'),
  CAMPAY_WEBHOOK_KEY: z.string().optional(),
  PAYUNIT_API_KEY: z.string().optional(),
  PAYUNIT_API_USERNAME: z.string().optional(),
  PAYUNIT_API_PASSWORD: z.string().optional(),
  PAYUNIT_MODE: z.enum(['test', 'live']).default('test'),
  FLUTTERWAVE_SECRET_KEY: z.string().optional(),
  FLUTTERWAVE_WEBHOOK_HASH: z.string().optional(),
  CAMERPAY_API_KEY: z.string().optional(), // Bearer token of the merchant account (camerpay.biz dashboard → API)
  CAMERPAY_WEBHOOK_SECRET: z.string().optional(), // the dashboard's "callback secret": webhooks are HMAC-SHA256 signed with it
  CAMERPAY_BASE_URL: z.string().default('https://camerpay.biz'),
  CAMERPAY_PLAN: z.enum(['starter', 'business', 'pro', 'byok']).default('starter'), // which CamerPay plan you pay for: decides its fee in the ranking

  // --- live exchange rates (FCFA → visitor currency) ---
  // Base XAF, one call returns every currency. ExchangeRate-API's open endpoint: no key, refreshed once a day, attribution required.
  FX_API_URL: z.string().default('https://open.er-api.com/v6/latest/XAF'),
  FX_CACHE_MINUTES: z.coerce.number().min(1).max(1440).default(360), // how long a fetched table is reused before asking again
  FX_MAX_STALE_HOURS: z.coerce.number().min(1).max(24 * 14).default(72), // older than this, a rate is NOT used: prices fall back to FCFA

  // --- gifts ---
  GIFT_PROVIDER: z.enum(['mock', 'campay']).optional(),
  // Overrides of the documented provider fees, e.g. {"campay":{"mobile_money":2.5},"notchpay":{"card":{"percent":3.9,"fixed":0.3,"fixedCurrency":"USD"}}}.
  // The router picks the cheapest available provider silently from documented fees + these overrides.
  PSP_FEES: z.string().optional(),
  // Pass-through fee on each gift (payout + collection costs), charged to the owner's wallet. PLACEHOLDER until the real
  // provider tariffs are known — see docs/DECISIONS.md. 0 would make SurveyFlow absorb fees on every gift.
  GIFT_FEE_PERCENT: z.coerce.number().min(0).max(30).default(5),

  // --- Google ---
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Where Google redirects after consent (a page of the web app). */
  GOOGLE_REDIRECT_URI: z.string().optional(),

  // --- puppeteer ---
  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),

  /** Run background workers (send queue, sweeper, gifts, billing) in this process. */
  RUN_JOBS: z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => v !== 'false' && v !== '0'),
});

export type Env = z.infer<typeof schema> & {
  isProd: boolean;
  jwtSecret: string;
  waMode: 'mock' | 'live';
  giftProvider: 'mock' | 'campay';
  pspFees: PspFees;
  webOrigins: string[];
};

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
    process.exit(1);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const waMode = e.WHATSAPP_MODE ?? (e.WHATSAPP_ACCESS_TOKEN ? 'live' : 'mock');
  const giftProvider = e.GIFT_PROVIDER ?? (e.CAMPAY_API_KEY ? 'campay' : 'mock');
  const jwtSecret = e.JWT_SECRET ?? (isProd ? '' : 'dev-only-jwt-secret-change-me-0123456789abcdef');

  // Fail fast in production: a silently-insecure deploy is worse than a crash.
  if (isProd) {
    const problems: string[] = [];
    if (jwtSecret.length < 32) problems.push('JWT_SECRET must be set (>= 32 chars)');
    if (!e.TOKEN_ENCRYPTION_KEY) problems.push('TOKEN_ENCRYPTION_KEY must be set (32 bytes, base64 or hex)');
    if (waMode === 'mock') problems.push('WhatsApp is in mock mode — set WHATSAPP_MODE=live and credentials');
    if (!e.META_APP_SECRET) problems.push('META_APP_SECRET is required to verify webhook signatures');
    if (e.PSP_MOCK) problems.push('PSP_MOCK must not be enabled in production');
    if (giftProvider === 'mock') problems.push('GIFT_PROVIDER=mock must not be used in production');
    if ((e.INTERNAL_API_SECRET ?? '').length < 32) problems.push('INTERNAL_API_SECRET must be set (>= 32 chars): without it anybody who can reach the API can call it directly, bypassing the website');
    // Receipt links and PSP/Meta callbacks are built from this address: it must be one the outside world can open.
    try {
      const u = new URL(e.PUBLIC_API_URL);
      const local = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(u.hostname) || !u.hostname.includes('.');
      if (u.protocol !== 'https:' || local) problems.push('PUBLIC_API_URL must be the API\'s public https address (receipt links and PSP/Meta callbacks are built from it), not localhost or a private address');
    } catch { problems.push('PUBLIC_API_URL is not a valid URL'); }
    // A production API that cannot take a payment would fail every customer at the last step, long after it started.
    const anyPsp = !!(e.NOTCHPAY_API_KEY || (e.CINETPAY_API_KEY && e.CINETPAY_SITE_ID) || e.CAMPAY_API_KEY || (e.PAYUNIT_API_KEY && e.PAYUNIT_API_USERNAME && e.PAYUNIT_API_PASSWORD)
      || e.FLUTTERWAVE_SECRET_KEY || (e.CAMERPAY_API_KEY && e.CAMERPAY_WEBHOOK_SECRET));
    if (!anyPsp) problems.push('No payment provider is configured (NOTCHPAY_API_KEY, CINETPAY_*, CAMPAY_API_KEY, PAYUNIT_*, FLUTTERWAVE_SECRET_KEY or CAMERPAY_*): customers could not pay');
    // Not fatal (the status poll and the reconciliation still settle payments), but every webhook of such a provider is refused as unsigned.
    for (const [name, key, secret, varName] of [
      ['NotchPay', e.NOTCHPAY_API_KEY, e.NOTCHPAY_WEBHOOK_HASH, 'NOTCHPAY_WEBHOOK_HASH'],
      ['Flutterwave', e.FLUTTERWAVE_SECRET_KEY, e.FLUTTERWAVE_WEBHOOK_HASH, 'FLUTTERWAVE_WEBHOOK_HASH'],
      ['Campay', e.CAMPAY_API_KEY, e.CAMPAY_WEBHOOK_KEY, 'CAMPAY_WEBHOOK_KEY'],
    ] as const) {
      if (key && !secret) console.warn(`[payments] ${name} is configured but ${varName} is not: its webhooks will be rejected as unsigned and payments settle only through polling and reconciliation (slower)`);
    }
    if (problems.length) {
      console.error('Refusing to start in production:\n' + problems.map((p) => '  - ' + p).join('\n'));
      process.exit(1);
    }
  }
  return {
    ...e,
    isProd,
    jwtSecret,
    waMode,
    giftProvider,
    pspFees: parsePspFees(e.PSP_FEES, e.CAMERPAY_PLAN),
    webOrigins: e.WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export const env = load();
