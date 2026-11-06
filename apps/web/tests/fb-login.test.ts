import { describe, expect, it } from 'vitest';
import { fbLogin, type FbSdk } from '../src/lib/fb-login';

/** A stand-in for the real SDK's own check, which is what rejected our async callback on the first real run. */
const strictSdk = (seen: { response?: unknown }): FbSdk => ({
  login(callback) {
    const type = Object.prototype.toString.call(callback).slice(8, -1).toLowerCase();
    if (type !== 'function') throw new Error(`Expression is of type ${type}, not function`);
    callback({ authResponse: { code: 'abc' } });
    seen.response = 'called';
  },
});

describe('FB.login callback', () => {
  it('the raw async handler is refused by an SDK that checks its type (the bug)', () => {
    expect(() => strictSdk({}).login(async () => undefined, {})).toThrow(/asyncfunction, not function/);
  });

  it('fbLogin hands the SDK a plain function and still runs the async handler to the end', async () => {
    const seen: { response?: unknown } = {};
    let handled: unknown = null;
    fbLogin(strictSdk(seen), { config_id: 'c' }, async (r) => { await new Promise((res) => setTimeout(res, 5)); handled = r; });
    expect(seen.response).toBe('called');
    await new Promise((res) => setTimeout(res, 30));
    expect(handled).toEqual({ authResponse: { code: 'abc' } });
  });

  it('an error inside the async handler does not escape as an unhandled rejection', async () => {
    fbLogin(strictSdk({}), {}, async () => { throw new Error('boom'); });
    await new Promise((res) => setTimeout(res, 20)); // would fail the run if the rejection were unhandled
    expect(true).toBe(true);
  });
});
