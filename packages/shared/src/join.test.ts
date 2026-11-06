import { describe, expect, it } from 'vitest';
import { countryAllowed, countryOfPhone, joinConsentText, joinLink, joinRefusal, parseJoinMessage } from './join';

const CODE = 'abcdefghijklmnopqrstuvwxyz'.replace(/[018-9]/g, '').slice(0, 26).padEnd(26, 'a');

describe('join message', () => {
  const code = 'a2b3c4d5e6f7a2b3c4d5e6f7a2';
  it('reads the code out of the words the link types', () => {
    expect(parseJoinMessage(`JOIN ${code}`)).toBe(code);
    expect(parseJoinMessage(`  join:${code}. `)).toBe(code);
    expect(parseJoinMessage(`Rejoindre - ${code.toUpperCase()}`)).toBe(code);
  });
  it('refuses anything that is not exactly a join request', () => {
    expect(parseJoinMessage('JOIN')).toBeNull();
    expect(parseJoinMessage(`JOIN ${code.slice(0, 25)}`)).toBeNull(); // too short
    expect(parseJoinMessage(`JOIN ${code}x`)).toBeNull(); // too long
    expect(parseJoinMessage(`please JOIN ${code}`)).toBeNull();
    expect(parseJoinMessage(`JOIN ${code} and send me gifts`)).toBeNull();
    expect(parseJoinMessage(`JOIN ${'1'.repeat(26)}`)).toBeNull(); // base32 has no 1, 0, 8, 9
    expect(CODE.length).toBe(26);
  });
  it('builds a wa.me link that types the join words', () => {
    const l = joinLink('+237 677 12 34 56', code);
    expect(l).toBe(`https://wa.me/237677123456?text=JOIN%20${code}`);
  });
});

describe('country of a number', () => {
  it('finds the country by calling code, longest first', () => {
    expect(countryOfPhone('+237677123456')).toBe('CM');
    expect(countryOfPhone('237677123456')).toBe('CM');
    expect(countryOfPhone('+2250712345678')).toBe('CI');
    expect(countryOfPhone('+4915112345678')).toBeNull();
  });
  it('an empty list is no limit; a list lets in only its countries', () => {
    expect(countryAllowed('+4915112345678', [])).toBe(true);
    expect(countryAllowed('+237677123456', ['CM', 'CI'])).toBe(true);
    expect(countryAllowed('+221771234567', ['CM', 'CI'])).toBe(false);
    expect(countryAllowed('+4915112345678', ['CM'])).toBe(false);
  });
});

describe('when a join is refused', () => {
  const base = { enabled: true, expiresAt: null, max: null, countries: [] as string[] };
  const ok = { surveyActive: true, joined: 0, phone: '+237677123456' };
  it('goes ahead when everything allows it', () => expect(joinRefusal(base, ok)).toBeNull());
  it('is refused when the link is off, the survey is not live, expired, full or from another country', () => {
    expect(joinRefusal({ ...base, enabled: false }, ok)).toBe('off');
    expect(joinRefusal(base, { ...ok, surveyActive: false })).toBe('closed');
    expect(joinRefusal({ ...base, expiresAt: new Date(1000) }, { ...ok, now: new Date(2000) })).toBe('expired');
    expect(joinRefusal({ ...base, expiresAt: new Date(3000) }, { ...ok, now: new Date(2000) })).toBeNull();
    expect(joinRefusal({ ...base, max: 5 }, { ...ok, joined: 5 })).toBe('full');
    expect(joinRefusal({ ...base, max: 5 }, { ...ok, joined: 4 })).toBeNull();
    expect(joinRefusal({ ...base, countries: ['CI'] }, ok)).toBe('country');
  });
});

describe('the first message to somebody who joined', () => {
  it('says who asks, what is kept, how to stop and what to type, in both languages', () => {
    const en = joinConsentText('en', 'Café Test', 'Delivery');
    expect(en).toContain('Café Test');
    expect(en).toContain('STOP');
    expect(en).toContain('START');
    expect(en).toMatch(/answers and this WhatsApp number/);
    const fr = joinConsentText('fr', 'Café Test', 'Livraison');
    expect(fr).toContain('STOP');
    expect(fr).toContain('START');
    expect(fr).toMatch(/réponses et ce numéro/);
  });

  it('carries the link to the participants’ notice before the START line when there is one, and is unchanged without it', () => {
    const url = 'https://surveyflow.example/privacy#participants';
    for (const lang of ['en', 'fr'] as const) {
      const withUrl = joinConsentText(lang, 'Café Test', 'Delivery', url);
      expect(withUrl).toContain(url);
      expect(withUrl.indexOf(url)).toBeLessThan(withUrl.indexOf('START'));
      expect(withUrl.indexOf('STOP')).toBeLessThan(withUrl.indexOf(url));
      expect(joinConsentText(lang, 'Café Test', 'Delivery')).not.toContain('http');
    }
  });
});
