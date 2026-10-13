import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

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
  INTERNAL_API_SECRET: z.string().optional(), // NextAuth → API (Google sign-in)

  // --- WhatsApp ---
  WHATSAPP_MODE: z.enum(['mock', 'live']).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional(),
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

  // --- gifts ---
  GIFT_PROVIDER: z.enum(['mock', 'campay']).optional(),

  // --- Google ---
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Where Google redirects after consent (a page of the web app). */
  GOOGLE_REDIRECT_URI: z.string().optional(),

  // --- billing policy ---
  /** What happens when a trial ends without payment: the spec says downgrade to Starter. */
  TRIAL_EXPIRY_POLICY: z.enum(['starter', 'suspend']).default('starter'),

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
    webOrigins: e.WEB_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export const env = load();
