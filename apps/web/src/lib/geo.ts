import { headers as nextHeaders } from 'next/headers';
import { COUNTRY_CONFIG, DEFAULT_COUNTRY, supportedCountry, type Currency } from '@surveyflow/shared';

/**
 * Where is the visitor? We do NOT ship an IP database (the common free ones carry licence terms we can't pass on silently).
 * The platform in front of the site already knows and says so in a header; we read it. Any one of these is enough:
 *   Vercel  x-vercel-ip-country      Cloudflare  cf-ipcountry      CloudFront  cloudfront-viewer-country
 * Behind none of them (plain localhost, a bare VPS) the country is simply UNKNOWN, and everything falls back to
 * Cameroon / FCFA, the product's default market. Unknown is never turned into a guess that gets stored.
 *
 * Local testing: DEV_GEO_COUNTRY=NG npm run dev -w @surveyflow/web (ignored in production builds).
 */
const COUNTRY_HEADERS = ['x-vercel-ip-country', 'cf-ipcountry', 'cloudfront-viewer-country'] as const;

export interface Geo {
  /** Supported country this visitor is treated as being in (CM when unknown or unsupported). */
  country: string;
  currency: Currency;
  /** True when a real location was read; false means we are showing the default market. */
  detected: boolean;
}

/** Two-letter country code the platform reported, upper-cased; undefined when absent / unknown ("XX") / Tor ("T1"). */
export function countryFromHeaders(h: { get(name: string): string | null }): string | undefined {
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_GEO_COUNTRY) return process.env.DEV_GEO_COUNTRY.trim().toUpperCase();
  for (const name of COUNTRY_HEADERS) {
    const v = h.get(name)?.trim().toUpperCase();
    if (v && /^[A-Z]{2}$/.test(v) && v !== 'XX') return v;
  }
  return undefined;
}

export function geoFrom(raw: string | undefined): Geo {
  const country = supportedCountry(raw);
  return { country, currency: COUNTRY_CONFIG[country]!.currency, detected: !!raw && raw === country };
}

/** For server components and layouts. */
export async function getGeo(): Promise<Geo> {
  return geoFrom(countryFromHeaders(await nextHeaders()));
}

export { DEFAULT_COUNTRY };
