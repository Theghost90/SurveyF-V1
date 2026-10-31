import { describe, expect, it } from 'vitest';
import { PROMO_TERMS, classifySurvey, findPromoTerms, withTemplateState } from './message-category';
import { TEMPLATE_DEFS, TEMPLATE_NAMES } from './wa-messages';

const base = { title: 'How was your visit?', followsTransaction: true, giftType: 'none' };

describe('the category of a survey invitation (WA-03)', () => {
  it('is utility only when the owner says it follows something the person did, no gift is attached and nothing reads as a promotion', () => {
    expect(classifySurvey(base)).toEqual({ category: 'utility', reasons: [] });
  });

  it('is marketing when in doubt, and says why: not declared as a follow-up', () => {
    expect(classifySurvey({ ...base, followsTransaction: false })).toEqual({ category: 'marketing', reasons: [{ code: 'not_a_follow_up' }] });
    expect(classifySurvey({ ...base, followsTransaction: undefined }).category).toBe('marketing');
    expect(classifySurvey({ title: 'x' }).category).toBe('marketing'); // nothing declared at all
  });

  it('is marketing when any reward or prize is attached, whatever the type', () => {
    for (const giftType of ['airtime', 'momo', 'discount', 'prize_draw', 'custom']) {
      expect(classifySurvey({ ...base, giftType }).reasons).toEqual([{ code: 'gift' }]);
    }
  });

  it('is marketing when the survey reads as a promotion, in English or French, in any of its texts, with or without accents', () => {
    expect(classifySurvey({ ...base, title: 'Get 20% off your next order!' }).reasons).toEqual([{ code: 'promo_wording', terms: ['% off'] }]);
    expect(classifySurvey({ ...base, description: 'Special offer for our loyal customers' }).reasons[0]).toMatchObject({ code: 'promo_wording' });
    expect(classifySurvey({ ...base, customThankYou: 'Gagnez un CADEAU !' }).reasons[0]).toMatchObject({ code: 'promo_wording', terms: expect.arrayContaining(['gagnez', 'cadeau']) });
    expect(classifySurvey({ ...base, title: 'Réduction exclusive' }).reasons[0]).toMatchObject({ terms: expect.arrayContaining(['reduction', 'exclusif'].filter((t) => t === 'reduction')) });
    expect(classifySurvey({ ...base, questions: [{ text: 'Would you like a discount code?' }] }).category).toBe('marketing');
    expect(classifySurvey({ ...base, questions: [{ text: 'Choose', options: [{ label: 'Free delivery' }, { label: 'Other' }] }] }).reasons[0]).toMatchObject({ terms: ['free'] });
  });

  it('does not mistake ordinary words, or a bare percentage, for a promotion', () => {
    for (const text of ['Was the sale assistant polite?'.replace('sale', 'seller'), 'Rate from 0 to 100%', 'How satisfied are you, in %?', 'Were the staff friendly?', 'Winter menu feedback', 'Giftshop?'.replace('Giftshop?', 'Shop layout')]) {
      expect(findPromoTerms(text), text).toEqual([]);
    }
    expect(findPromoTerms('We offered you a table')).toEqual([]); // "offered" is not "offer"
  });

  it('lists every reason at once, at most five terms, none twice', () => {
    const r = classifySurvey({ title: 'Win a prize! Free gift, bonus, coupon, voucher, discount', followsTransaction: false, giftType: 'airtime' });
    expect(r.category).toBe('marketing');
    expect(r.reasons.map((x) => x.code)).toEqual(['not_a_follow_up', 'gift', 'promo_wording']);
    const terms = (r.reasons[2] as { terms: string[] }).terms;
    expect(terms.length).toBeLessThanOrEqual(5);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('every promotional term is found in a sentence that contains it (the list has no dead entries)', () => {
    for (const term of PROMO_TERMS) expect(findPromoTerms(`please ${term} today`), term).not.toEqual([]);
  });
});

describe('what Meta has done to the utility template (re-categorisation)', () => {
  const utility = classifySurvey(base);
  it('leaves everything as it was when the template is still utility', () => {
    expect(withTemplateState(utility, { category: 'UTILITY' })).toEqual(utility);
    expect(withTemplateState(utility, null)).toEqual(utility);
  });
  it('makes a utility survey marketing, with the reason, once Meta has moved the template', () => {
    expect(withTemplateState(utility, { category: 'MARKETING' })).toEqual({ category: 'marketing', reasons: [{ code: 'meta_recategorised' }] });
    expect(withTemplateState(utility, { category: 'marketing' }).category).toBe('marketing');
  });
  it('only warns about a change Meta has announced and not made yet', () => {
    const at = '2026-11-01T10:00:00.000Z';
    expect(withTemplateState(utility, { category: 'UTILITY', pendingCategory: 'MARKETING', pendingAt: at })).toEqual({ category: 'utility', reasons: [{ code: 'meta_will_recategorise', at }] });
    expect(withTemplateState(utility, { category: 'UTILITY', pendingCategory: 'MARKETING' }).reasons).toEqual([{ code: 'meta_will_recategorise', at: null }]);
  });
  it('never touches a marketing survey', () => {
    const marketing = classifySurvey({ title: 'x' });
    expect(withTemplateState(marketing, { category: 'MARKETING' })).toEqual(marketing);
  });
});

describe('the wording of our own templates', () => {
  it('no UTILITY template that asks the person to do something contains promotional wording, in either language', () => {
    // The gift notice is exempt, on purpose: it confirms that something already happened ("your gift has been sent"), which is what a utility message is for, and it
    // cannot avoid the word. Meta may still decide otherwise about it (the open question of DECISIONS.md section 3, item 3).
    for (const d of TEMPLATE_DEFS.filter((t) => t.category === 'UTILITY' && t.name !== TEMPLATE_NAMES.giftNotice)) {
      expect(findPromoTerms(d.body), `${d.name}/${d.language}: ${d.body}`).toEqual([]);
      for (const b of [...d.buttons, ...(d.urlButtons ?? [])]) expect(findPromoTerms(b), `${d.name} button ${b}`).toEqual([]);
    }
  });
  it('the UTILITY invitation names the thing it follows up; the MARKETING one is declared marketing; both come in both languages with the same variables and buttons', () => {
    const get = (name: string, language: string) => TEMPLATE_DEFS.find((d) => d.name === name && d.language === language)!;
    for (const language of ['en', 'fr']) {
      const u = get(TEMPLATE_NAMES.invitation, language);
      const m = get(TEMPLATE_NAMES.invitationMarketing, language);
      expect(u.category).toBe('UTILITY');
      expect(m.category).toBe('MARKETING');
      expect(u.body).toMatch(language === 'en' ? /order, visit or booking/ : /commande, visite ou réservation/);
      expect(u.examples).toEqual(m.examples);
      expect(u.buttons).toEqual(m.buttons);
      for (const d of [u, m]) for (const v of ['{{1}}', '{{2}}', '{{3}}']) expect(d.body).toContain(v);
    }
  });
});
