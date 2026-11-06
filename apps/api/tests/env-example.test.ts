import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { envIssues, loadEnv, withoutBlanks } from '../src/config/env';

/**
 * Found by following the README to the letter: `cp .env.example .env`, then `npm run dev`. The API refused to start ("Invalid environment: EMAIL_PROVIDER ...,
 * WHATSAPP_PLATFORM_PHONE ..."): optional settings ship blank in the example and a blank was read as an empty value. Behind that, a blank PUBLIC_WEB_URL gave the
 * e-mails links without an address, so the demo mailbox showed no confirmation button. The unit tests never saw it: they do not read the example file. This one
 * does, with the same parser Node uses for `--env-file`.
 */
const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));

describe('.env.example, copied to .env as the README says, is an environment the API accepts', () => {
  it('has no invalid setting, and what it leaves blank falls back to the default', () => {
    expect(Object.keys(example).length).toBeGreaterThan(20); // it was read at all
    expect(envIssues(example)).toEqual([]);
    const e = loadEnv(example);
    expect(e.emailProvider).toBe('mock'); // EMAIL_PROVIDER is blank
    expect(e.webBaseUrl).toBe('http://localhost:4222'); // PUBLIC_WEB_URL is blank: the links in e-mails still carry an address
    expect(e.jwtSecret.length).toBeGreaterThanOrEqual(32); // JWT_SECRET is blank: development's own secret, not an empty one
    expect(e.require2faPlans).toEqual(['business']);
  });

  it('a blank setting is a setting that is not there, whatever its type; a wrong one is still refused', () => {
    expect(withoutBlanks({ A: '', B: '   ', C: 'x', D: undefined })).toEqual({ C: 'x' });
    expect(envIssues({ ...example, EMAIL_PROVIDER: '  ', WHATSAPP_PLATFORM_PHONE: '' })).toEqual([]);
    expect(loadEnv({ ...example, ACCESS_TOKEN_TTL_SECONDS: '' }).ACCESS_TOKEN_TTL_SECONDS).toBe(900); // a number: the default, not 0
    expect(envIssues({ ...example, EMAIL_PROVIDER: 'nonsense' })).toEqual([expect.stringContaining('EMAIL_PROVIDER')]);
    expect(envIssues({ ...example, WHATSAPP_PLATFORM_PHONE: '12ab' })).toEqual([expect.stringContaining('WHATSAPP_PLATFORM_PHONE')]);
    expect(envIssues({ ...example, ACCESS_TOKEN_TTL_SECONDS: '5' })).toEqual([expect.stringContaining('ACCESS_TOKEN_TTL_SECONDS')]);
  });
});
