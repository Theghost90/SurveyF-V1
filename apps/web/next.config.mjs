import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One .env at the repo root serves both apps (Next only reads its own folder by default).
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) {
  try { process.loadEnvFile(rootEnv); } catch { /* older Node: use apps/web/.env.local instead */ }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package ships TypeScript source.
  transpilePackages: ['@surveyflow/shared'],
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  // The image optimizer (/_next/image) is never used (no next/image anywhere) and has had critical advisories; turn it off rather than leave it listening.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/(.*)',
        // The Content-Security-Policy is built per request (it carries a one-time nonce): see src/middleware.ts and src/lib/csp.ts.
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Nothing here needs the camera, microphone, location, payment sheet or USB: say so, so an injected script cannot ask either.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
          // Browsers ignore this over plain http, so it only takes effect where the site is really served over https.
          ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
        ],
      },
    ];
  },
};
export default nextConfig;
