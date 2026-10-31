import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Found by following the README to the letter: `cp .env.example .env`, `npm run dev`, sign in. The example ships NEXTAUTH_SECRET blank, the API accepted the password
 * and the website answered 500 because it cannot sign a cookie with a blank secret. Development now gets a throw-away one (like the API's JWT_SECRET); production
 * must never get one: with a blank secret nobody can sign in there, on purpose.
 */
const CONFIG = new URL('../next.config.mjs', import.meta.url).href;
let n = 0;

/** What NEXTAUTH_SECRET is once next.config.mjs has run in this environment (a fresh copy of the module each time: it acts when it is loaded). */
async function secretAfterConfig(env: { NODE_ENV: string; NEXTAUTH_SECRET: string }) {
  vi.stubEnv('NODE_ENV', env.NODE_ENV);
  vi.stubEnv('NEXTAUTH_SECRET', env.NEXTAUTH_SECRET);
  await import(/* @vite-ignore */ `${CONFIG}?run=${++n}`);
  return process.env.NEXTAUTH_SECRET;
}
afterEach(() => vi.unstubAllEnvs());

describe('the website session secret in next.config.mjs', () => {
  it('development fills a blank one (and a whitespace-only one) with a throw-away secret long enough to sign with', async () => {
    expect((await secretAfterConfig({ NODE_ENV: 'development', NEXTAUTH_SECRET: '' }))!.length).toBeGreaterThanOrEqual(32);
    expect((await secretAfterConfig({ NODE_ENV: 'development', NEXTAUTH_SECRET: '   ' }))!.length).toBeGreaterThanOrEqual(32);
  });

  it('development keeps a secret somebody chose', async () => {
    expect(await secretAfterConfig({ NODE_ENV: 'development', NEXTAUTH_SECRET: 'chosen-by-the-owner-0123456789abcdef' })).toBe('chosen-by-the-owner-0123456789abcdef');
  });

  it('production never gets one: blank stays blank', async () => {
    expect(await secretAfterConfig({ NODE_ENV: 'production', NEXTAUTH_SECRET: '' })).toBe('');
  });

  it('only development does: any other mode is left as it is', async () => {
    expect(await secretAfterConfig({ NODE_ENV: 'test', NEXTAUTH_SECRET: '' })).toBe('');
  });
});
