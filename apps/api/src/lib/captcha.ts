import { env } from '../config/env';

/**
 * CAPTCHA (Cloudflare Turnstile). Verified here, on the server, with the secret: the browser's "I passed" means nothing by itself.
 * Not configured (development, tests, the shared demo) means no CAPTCHA at all; production refuses to start without either the keys or an explicit
 * CAPTCHA_DISABLED=true (config/env.ts).
 */
export const captchaEnabled = (): boolean => env.captchaEnabled;

export async function verifyCaptcha(token: string | undefined | null, ip?: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!env.captchaEnabled) return true;
  if (!token || token.length > 4096) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token });
    if (ip && ip !== 'unknown') body.set('remoteip', ip);
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    // Cloudflare unreachable: refusing everyone would lock every owner out; the progressive delays and rate limits still apply. Fail open, loudly.
    console.warn('[captcha] verification service unreachable; letting the request through');
    return true;
  }
}
