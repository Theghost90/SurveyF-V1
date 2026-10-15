import { describe, expect, it } from 'vitest';
import {
  PLANS, buildQuestionMessage, buildThankYouMessage, costPerAnswer, formatFCFA, fromWaId, maskPhone, normalizePhone,
  parseAnswerId, parseTemplatePayload, planPriceIn, identityQuote, questionInputSchema, recommendPlan, responseOverageFCFA, templatePayload, toWaId, answerId,
  publishProblems, normalizeQuestion,
} from './index';

describe('phone', () => {
  it('normalises Cameroonian mobile numbers from common spellings', () => {
    for (const raw of ['677123456', '677 12 34 56', '+237 677 12 34 56', '00237677123456', '237677123456', '(+237) 677-123-456']) {
      expect(normalizePhone(raw)).toBe('+237677123456');
    }
  });
  it('rejects junk', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('abcdefghi')).toBeNull();
  });
  it('round-trips the WhatsApp id form', () => {
    expect(toWaId('+237677123456')).toBe('237677123456');
    expect(fromWaId('237677123456')).toBe('+237677123456');
  });
  it('masks like the dashboard mockups', () => {
    expect(maskPhone('+237677123456')).toBe('+237 6XX XXX 456');
  });
});

describe('plans', () => {
  it('uses the owner-set prices and the spec limits', () => {
    expect(PLANS.starter.priceFCFA).toBe(14500);
    expect(PLANS.growth.limits.responsesPerMonth).toBe(3000);
    expect(PLANS.business.limits.activeSurveys).toBeNull();
    expect(PLANS.starter.features.giftAutomation).toBe(false);
  });
  it('recommends the plan that fits a volume', () => {
    expect(recommendPlan(100)).toBe('starter');
    expect(recommendPlan(500)).toBe('starter');
    expect(recommendPlan(501)).toBe('growth');
    expect(recommendPlan(3000)).toBe('growth');
    expect(recommendPlan(12000)).toBe('business');
  });
  it('computes cost per answer and annual price', () => {
    expect(costPerAnswer('growth', 3000)).toBeCloseTo(13, 1);
    expect(planPriceIn('growth', 'annual', identityQuote('XAF'))).toBe(390000);
  });
  it('charges overage in blocks of 100 responses', () => {
    expect(responseOverageFCFA('starter', 500)).toBe(0);
    expect(responseOverageFCFA('starter', 501)).toBe(500);
    expect(responseOverageFCFA('starter', 700)).toBe(1000);
  });
  it('formats FCFA', () => {
    expect(formatFCFA(39000)).toBe('39,000');
    expect(formatFCFA(95000, 'fr')).toBe('95\u202f000');
  });
});

describe('question validation (WhatsApp limits)', () => {
  const opt = (label: string, i = 0) => ({ id: `o${i}`, label });
  const q = (type: string, options: any, extra: any = {}) => questionInputSchema.safeParse({ text: 'Q?', type, options, required: true, ...extra });

  it('rejects more than 3 buttons, accepts 3', () => {
    expect(q('button', [opt('a', 1), opt('b', 2), opt('c', 3), opt('d', 4)]).success).toBe(false);
    expect(q('button', [opt('a', 1), opt('b', 2), opt('c', 3)]).success).toBe(true);
  });
  it('rejects button titles over 20 chars and list rows over 24', () => {
    expect(q('button', [opt('x'.repeat(21), 1), opt('b', 2)]).success).toBe(false);
    expect(q('list', [opt('x'.repeat(25), 1), opt('b', 2)]).success).toBe(false);
    expect(q('list', [opt('x'.repeat(24), 1), opt('b', 2)]).success).toBe(true);
  });
  it('allows up to 10 list rows, not 11', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => opt(`Option ${i}`, i));
    expect(q('list', rows(10)).success).toBe(true);
    expect(q('list', rows(11)).success).toBe(false);
  });
  it('rejects duplicate labels and single-option questions', () => {
    expect(q('list', [opt('A', 1), opt('a', 2)]).success).toBe(false);
    expect(q('list', [opt('A', 1)]).success).toBe(false);
  });
  it('text questions take no options; rating gets a fixed 1-5 scale', () => {
    expect(q('text', [opt('a', 1)]).success).toBe(false);
    const r = q('rating', null);
    expect(r.success).toBe(true);
    expect(normalizeQuestion(r.data!).options).toHaveLength(5);
  });
  it('flags unpublishable surveys', () => {
    expect(publishProblems({ questions: [] })).toContain('Add at least one question');
    expect(publishProblems({ questions: [{ text: 'ok', type: 'text' }] })).toEqual([]);
  });
});

describe('WhatsApp message builders', () => {
  const base = { id: 'q1', text: 'How was it?', required: true };
  it('uses reply buttons for ≤3 options with ids that carry the question id', () => {
    const m = buildQuestionMessage({ ...base, type: 'button', options: [{ id: 'a', label: 'Good' }, { id: 'b', label: 'Bad' }] }, 0, 3, 'en');
    expect(m.kind).toBe('buttons');
    if (m.kind === 'buttons') {
      expect(m.buttons[0]).toEqual({ id: 'a:q1:a', title: 'Good' });
      expect(m.body).toContain('Question 1 of 3');
    }
  });
  it('renders a 1–5 rating as a LIST (WhatsApp allows only 3 reply buttons)', () => {
    const m = buildQuestionMessage({ ...base, type: 'rating' }, 1, 3, 'fr');
    expect(m.kind).toBe('list');
    if (m.kind === 'list') {
      expect(m.rows).toHaveLength(5);
      expect(m.body).toContain('Question 2 sur 3');
    }
  });
  it('renders multi-select as a numbered text prompt and adds the skip hint when optional', () => {
    const m = buildQuestionMessage({ ...base, required: false, type: 'multi', options: [{ id: 'a', label: 'Red' }, { id: 'b', label: 'Blue' }] }, 0, 1, 'en');
    expect(m.kind).toBe('text');
    if (m.kind === 'text') {
      expect(m.body).toContain('1. Red');
      expect(m.body).toContain('SKIP');
    }
  });
  it('round-trips answer / template ids', () => {
    expect(parseAnswerId(answerId('q1', 'o:weird'))).toEqual({ questionId: 'q1', optionId: 'o:weird' });
    expect(parseAnswerId('nonsense')).toBeNull();
    expect(parseTemplatePayload(templatePayload('START', 's9'))).toEqual({ action: 'START', surveyId: 's9' });
  });
  it('builds a thank-you with the gift line only when a code exists for discounts', () => {
    expect(buildThankYouMessage({ giftType: 'discount', giftValue: '10% off', code: 'SF-ABC' }, 'en')).toContain('SF-ABC');
    expect(buildThankYouMessage({ giftType: 'discount' }, 'en')).not.toContain('code');
    expect(buildThankYouMessage({ giftType: 'none', customThankYou: 'See you soon' }, 'fr')).toContain('See you soon');
  });
});
