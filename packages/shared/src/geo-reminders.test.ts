import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { describe, expect, it } from 'vitest';
import {
  COUNTRY_CONFIG, DEFAULT_COUNTRY, PAID_PLAN_KEYS, abandonerSlot, addBusinessDays, alignToSendWindow, closingNoteFor, countryWithCurrency,
  currencyForCountry, dialPrefix, endOfLocalDay, followupSlot, formatDeadline, formatPrice, localDateString, nonResponderSlot, overagePerBlock, rankByFee,
  supportedCountry, usesEventRule, type Currency, type FxQuote, PSP_CHARGE_CURRENCIES, PSP_FEE_SOURCES, convertToXAF, costPerAnswer, documentedFees, effectiveFeeXAF, eurQuote, giftFee, giftUnitCost,
  identityQuote, planPriceIn, planPrices, roundNice, roundPrice, walletLimits, PSP_CAPABILITIES,
} from './index';

const CM = 60; // Cameroon: UTC+1, no DST
/** Local Cameroon wall-clock → Date. Oct 12 2026 is a Monday. */
const cm = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, day, h - 1, m));
const show = (d: Date | undefined | null) => (d ? new Date(d.getTime() + CM * 60_000).toISOString().slice(0, 16).replace('T', ' ') : null);

describe('countries and phone examples', () => {
  it('every country example is a VALID mobile-style number for that country and carries its dial code', () => {
    for (const [code, c] of Object.entries(COUNTRY_CONFIG)) {
      const p = parsePhoneNumberFromString(c.phoneExample.replace(/\s/g, ''), code as never);
      expect(p?.isValid(), `${code} example ${c.phoneExample}`).toBe(true);
      expect(c.phoneExample.startsWith(`+${c.callingCode}`), code).toBe(true);
    }
  });
  it('an unknown or unsupported country falls back to Cameroon / XAF', () => {
    expect(supportedCountry('ng')).toBe('NG');
    expect(supportedCountry('US')).toBe(DEFAULT_COUNTRY);
    expect(supportedCountry(undefined)).toBe('CM');
    expect(supportedCountry('')).toBe('CM');
    expect(currencyForCountry('FR')).toBe('XAF');
    expect(dialPrefix('XX')).toBe('+237');
  });
  it('shows "Country (CUR)" in the UI language', () => {
    expect(countryWithCurrency('CM')).toBe('Cameroon (XAF)');
    expect(countryWithCurrency('CM', 'fr')).toBe('Cameroun (XAF)');
    expect(countryWithCurrency('CI')).toBe("Côte d'Ivoire (XOF)");
    expect(countryWithCurrency('NG')).toBe('Nigeria (NGN)');
  });
  it('every supported country\'s currency is one the payment providers can charge in (so a price in it can actually be collected)', () => {
    for (const c of Object.values(COUNTRY_CONFIG)) expect(PSP_CHARGE_CURRENCIES, c.name).toContain(c.currency as Currency);
    expect(PAID_PLAN_KEYS).toHaveLength(3);
  });
});

describe('the euro', () => {
  it('is a currency the providers charge in: every provider but Campay (Cameroon mobile money, XAF only)', () => {
    expect(PSP_CHARGE_CURRENCIES).toContain('EUR');
    for (const [psp, cap] of Object.entries(PSP_CAPABILITIES)) expect(cap.currencies.includes('EUR'), psp).toBe(psp !== 'campay');
  });
  it('is priced at the CFA franc\'s fixed peg (655.957 per euro), whole euros, annual = 11 months converted once', () => {
    expect(planPrices(eurQuote())).toEqual({ starter: { monthly: 22, annual: 243 }, growth: { monthly: 59, annual: 654 }, business: { monthly: 145, annual: 1590 } });
    expect(convertToXAF(22, eurQuote())).toBe(14_431);
    expect(overagePerBlock(eurQuote())).toBe(0.76);
  });
  it('has euro wallet limits of tidy values (the gift minimum is one whole euro: amounts are whole units)', () => {
    expect(walletLimits(eurQuote())).toEqual({ topupMin: 2, topupMax: 2_000, presets: [10, 20, 50, 100, 200], giftMin: 1, giftMax: 20 });
  });
});

const NGN: FxQuote = { currency: 'NGN', rate: 2.4, asOf: '2026-10-15T00:00:00Z', source: 'live' };
const USD: FxQuote = { currency: 'USD', rate: 1 / 580, asOf: '2026-10-15T00:00:00Z', source: 'live' };

describe('prices in the visitor currency (live conversion of the FCFA prices)', () => {
  it('formats FCFA the product way and other currencies with their own style', () => {
    expect(formatPrice(14500, 'XAF')).toBe('14,500 FCFA');
    expect(formatPrice(14500, 'XOF', 'fr')).toBe('14\u202f500 FCFA');
    expect(formatPrice(23, 'USD')).toBe('23 USD');
    expect(formatPrice(0.86, 'USD')).toBe('0.86 USD');
    expect(formatPrice(0.86, 'USD', 'fr')).toBe('0,86 USD');
    expect(formatPrice(35000, 'NGN')).toBe('35,000 NGN');
    expect(formatPrice(2900, 'KES', 'fr')).toBe('2\u202f900 KES');
  });

  it('CFA francs never change: XAF and XOF are 1:1, so the FCFA prices are exactly the owner\'s', () => {
    expect(planPrices(identityQuote('XAF'))).toEqual({ starter: { monthly: 14_500, annual: 159_500 }, growth: { monthly: 39_000, annual: 429_000 }, business: { monthly: 95_000, annual: 1_045_000 } });
    expect(planPriceIn('growth', 'monthly', identityQuote('XOF'))).toBe(39_000);
  });

  it('other currencies are the rate times the FCFA price, rounded to 3 significant digits; annual is 10 months converted once', () => {
    expect(planPriceIn('starter', 'monthly', NGN)).toBe(34_800); // 14,500 × 2.4
    expect(planPriceIn('starter', 'annual', NGN)).toBe(383_000); // 11 × 34,800
    expect(planPriceIn('business', 'monthly', NGN)).toBe(228_000);
    expect(planPriceIn('starter', 'monthly', USD)).toBe(25); // 14,500 / 580
    expect(planPriceIn('growth', 'monthly', USD)).toBe(67); // charged amounts are whole units
    expect(planPriceIn('starter', 'monthly', eurQuote())).toBe(22); // fixed peg 655.957
  });

  it('the rounding policy', () => {
    expect(roundPrice(35_214, 'NGN')).toBe(35_200);
    expect(roundPrice(94_123, 'NGN')).toBe(94_100);
    expect(roundPrice(3_120.4, 'KES')).toBe(3_120);
    expect(roundPrice(842.6, 'NGN')).toBe(843);
    expect(roundPrice(26.34, 'USD')).toBe(26);
    expect(roundPrice(0.845, 'USD')).toBe(0.85);
    expect(roundPrice(0, 'USD')).toBe(0);
    expect(roundNice(243)).toBe(200);
    expect(roundNice(2_400_000)).toBe(2_000_000);
    expect(roundNice(48_000)).toBe(50_000);
  });

  it('converts back to XAF for the payout provider, which only speaks CFA francs', () => {
    expect(convertToXAF(1_200, NGN)).toBe(500);
    expect(convertToXAF(500, identityQuote())).toBe(500);
    expect(convertToXAF(26, USD)).toBe(15_080);
  });

  it('scales the overage block per currency and keeps 500 FCFA', () => {
    expect(overagePerBlock(identityQuote('XAF'))).toBe(500);
    expect(overagePerBlock(identityQuote('XOF'))).toBe(500);
    expect(overagePerBlock(NGN)).toBe(1_200);
    expect(overagePerBlock(USD)).toBe(0.86);
  });

  it('cost per answer follows the currency too', () => {
    expect(costPerAnswer('starter', 500, identityQuote())).toBe(29);
    expect(costPerAnswer('starter', 500, NGN)).toBeCloseTo(69.6, 1);
  });
});

describe('wallet limits in the owner\'s currency', () => {
  it('are the FCFA limits in FCFA, and tidy converted values elsewhere', () => {
    expect(walletLimits(identityQuote())).toEqual({ topupMin: 2_000, topupMax: 1_000_000, presets: [5_000, 10_000, 25_000, 50_000, 100_000], giftMin: 100, giftMax: 20_000 });
    expect(walletLimits(NGN)).toEqual({ topupMin: 5_000, topupMax: 2_000_000, presets: [10_000, 20_000, 50_000, 100_000, 200_000], giftMin: 200, giftMax: 50_000 });
  });
  it('the gift fee is rounded UP in whichever currency, never losing a fraction', () => {
    expect(giftFee(500, 5)).toBe(25);
    expect(giftFee(201, 5)).toBe(11);
    expect(giftUnitCost(500, 5)).toBe(525);
  });
});

describe('PSP fees from the contract document, and ranking', () => {
  const fees = documentedFees('starter');
  const MM = ['campay', 'notchpay', 'camerpay', 'payunit', 'cinetpay'] as const;
  const toXAF = (amount: number, currency: string) => (currency === 'USD' ? amount * 580 : currency === 'EUR' ? amount * 655.957 : null);

  it('mobile money, cheapest first: NotchPay 1.0 %, Campay 2.0 %, CinetPay 2.5 %, CamerPay Starter 3.0 %; PayUnit (no fee in the document) last', () => {
    expect(rankByFee([...MM], 'mobile_money', fees)).toEqual(['notchpay', 'campay', 'cinetpay', 'camerpay', 'payunit']);
  });
  it('CamerPay on its Business plan (1.5 %) moves up; on Pro (1.0 %) it ties NotchPay and keeps the configured order', () => {
    expect(rankByFee([...MM], 'mobile_money', documentedFees('business'))).toEqual(['notchpay', 'camerpay', 'campay', 'cinetpay', 'payunit']);
    expect(rankByFee([...MM], 'mobile_money', documentedFees('pro'))).toEqual(['notchpay', 'camerpay', 'campay', 'cinetpay', 'payunit']);
    expect(rankByFee(['camerpay', 'notchpay'], 'mobile_money', documentedFees('byok'))).toEqual(['camerpay', 'notchpay']); // 0 % beats 1 %
  });
  it('cards: the fixed part matters on a small payment ($0.30 on 14,500 FCFA), so the order differs from the percentages alone', () => {
    const cards = ['camerpay', 'notchpay', 'cinetpay', 'flutterwave'] as const;
    expect(rankByFee([...cards], 'card', fees)).toEqual(['cinetpay', 'notchpay', 'flutterwave', 'camerpay']); // percent only: 3.5, 3.9, 4.8, 5.9
    expect(rankByFee([...cards], 'card', fees, { amountXAF: 14_500, fixedToXAF: toXAF })).toEqual(['cinetpay', 'flutterwave', 'notchpay', 'camerpay']); // NotchPay 3.9 % + $0.30 ≈ 5.1 % > Flutterwave 4.8 %
  });
  it('a missing rate for the fixed part is ignored rather than guessed', () => {
    expect(effectiveFeeXAF({ percent: 3.9, fixed: 0.3, fixedCurrency: 'USD' }, 10_000, () => null)).toBeCloseTo(390, 5);
  });
  it('a fee configured for another method does not count; unknown fees keep configured order', () => {
    expect(rankByFee(['campay', 'notchpay'], 'mobile_money', {})).toEqual(['campay', 'notchpay']);
    expect(rankByFee(['campay'], 'card', fees)).toEqual(['campay']); // Campay has no card fee: not natively supported
  });
  it('every provider has its source link recorded', () => {
    expect(PSP_FEE_SOURCES.camerpay.docs).toBe('https://camerpay.biz/docs/');
    expect(PSP_FEE_SOURCES.notchpay.pricing).toBe('https://www.notchpay.co/pricing');
    expect(PSP_FEE_SOURCES.cinetpay.pricing).toBe('https://cinetpay.com/pricing');
    expect(PSP_FEE_SOURCES.flutterwave.pricing).toBe('https://flutterwave.com/cm/pricing');
    expect(PSP_FEE_SOURCES.campay.pricing).toBe('https://www.campay.net/fr/');
  });
});

describe('business days and the sending window', () => {
  it('skips weekends when adding business days (Fri + 3 = Wed) and keeps the time of day', () => {
    expect(show(addBusinessDays(cm(16, 11), 3, CM))).toBe('2026-10-21 11:00');
    expect(show(addBusinessDays(cm(17, 11), 3, CM))).toBe('2026-10-21 11:00'); // from Saturday
  });
  it('never sends at night: before 08:00 waits for 08:00, after 19:00 waits for the next morning', () => {
    expect(show(alignToSendWindow(cm(14, 6, 30), CM, false))).toBe('2026-10-14 08:00');
    expect(show(alignToSendWindow(cm(14, 19, 0), CM, false))).toBe('2026-10-15 08:00');
    expect(show(alignToSendWindow(cm(14, 12, 0), CM, false))).toBe('2026-10-14 12:00');
  });
  it('the standard rule only sends on weekdays; the event rule may send any day', () => {
    expect(show(alignToSendWindow(cm(17, 10), CM, true))).toBe('2026-10-19 08:00'); // Saturday → Monday
    expect(show(alignToSendWindow(cm(18, 10), CM, false))).toBe('2026-10-18 10:00'); // Sunday stays Sunday
    expect(show(alignToSendWindow(cm(16, 20), CM, true))).toBe('2026-10-19 08:00'); // Friday night → Monday
  });
});

describe('non-responders', () => {
  const general = { kind: 'general', deadlineAt: null };
  it('standard rule: one reminder from the 3rd business day, stale after the 5th', () => {
    const s = nonResponderSlot(cm(12, 11), general, CM)!;
    expect(s.rule).toBe('standard');
    expect(show(s.earliest)).toBe('2026-10-15 11:00'); // Mon → Thu
    expect(show(s.latest)).toBe('2026-10-19 19:00'); // Mon → next Mon, end of the sending day
  });
  it('standard rule respects the evening window and the weekend', () => {
    expect(show(nonResponderSlot(cm(16, 20, 30), general, CM)!.earliest)).toBe('2026-10-22 08:00'); // Fri night: +3bd = Wed 20:30 → Thu 08:00
    expect(show(nonResponderSlot(cm(14, 10), general, CM)!.earliest)).toBe('2026-10-19 10:00'); // Wed → Mon
  });
  it('event rule: 24 h after the invitation when the deadline is within a week', () => {
    const ev = { kind: 'event', deadlineAt: cm(18, 18) };
    expect(usesEventRule(ev, cm(14, 9))).toBe(true);
    const s = nonResponderSlot(cm(14, 9), ev, CM)!;
    expect(s.rule).toBe('event');
    expect(show(s.earliest)).toBe('2026-10-15 09:00');
  });
  it('an event survey whose deadline is more than 7 days away uses the standard rule (not aggressive)', () => {
    const far = { kind: 'event', deadlineAt: cm(30, 18) };
    expect(usesEventRule(far, cm(14, 9))).toBe(false);
    expect(nonResponderSlot(cm(14, 9), far, CM)!.rule).toBe('standard');
  });
  it('no reminder when there is no sensible time left before the deadline', () => {
    expect(nonResponderSlot(cm(14, 9), { kind: 'event', deadlineAt: cm(15, 3) }, CM)).toBeNull(); // 24 h later is already past the deadline
    expect(nonResponderSlot(cm(12, 11), { kind: 'general', deadlineAt: cm(14, 18) }, CM)).toBeNull(); // standard reminder (Thu) would be after it
  });
  it('the reminder window never extends past the deadline', () => {
    const s = nonResponderSlot(cm(12, 11), { kind: 'general', deadlineAt: cm(16, 12) }, CM)!;
    expect(s.latest.getTime()).toBeLessThanOrEqual(cm(16, 11).getTime());
  });
});

describe('abandoners', () => {
  const general = { kind: 'general', deadlineAt: null };
  it('standard rule: 2 business days after the survey reached them, never before they were flagged', () => {
    const early = abandonerSlot(cm(12, 11), cm(13, 12), general, CM)!;
    expect(show(early.earliest)).toBe('2026-10-14 11:00'); // Mon + 2bd, they abandoned on Tue
    const late = abandonerSlot(cm(12, 11), cm(16, 9), general, CM)!;
    expect(show(late.earliest)).toBe('2026-10-16 09:00'); // abandoned Friday morning: not before that
    expect(show(early.latest)).toBe('2026-10-15 19:00'); // one more business day to deliver
  });
  it('event rule: reminder as soon as they are flagged (in the sending window), any day', () => {
    const ev = { kind: 'event', deadlineAt: cm(20, 18) };
    const s = abandonerSlot(cm(17, 10), cm(18, 22), ev, CM)!; // flagged Sunday 22:00 → Monday 08:00
    expect(s.rule).toBe('event');
    expect(show(s.earliest)).toBe('2026-10-19 08:00');
  });
});

describe('closing notes', () => {
  it('abandoners always get one; non-responders only under the event rule', () => {
    expect(closingNoteFor('abandoner', 'standard')).toBe('progress_saved');
    expect(closingNoteFor('abandoner', 'event')).toBe('progress_saved_deadline');
    expect(closingNoteFor('nonResponder', 'event')).toBe('deadline_note');
    expect(closingNoteFor('nonResponder', 'standard')).toBeNull();
  });
  it('the note comes 24 h after the reminder (event: any day; standard: weekdays only)', () => {
    const general = { kind: 'general', deadlineAt: null };
    expect(show(followupSlot(cm(15, 11), 'abandoner', 'standard', general, CM)!.earliest)).toBe('2026-10-16 11:00');
    expect(show(followupSlot(cm(16, 11), 'abandoner', 'standard', general, CM)!.earliest)).toBe('2026-10-19 08:00'); // Fri +24h = Sat → Monday
    expect(followupSlot(cm(15, 11), 'nonResponder', 'standard', general, CM)).toBeNull();
    const ev = { kind: 'event', deadlineAt: cm(22, 18) };
    expect(show(followupSlot(cm(16, 11), 'nonResponder', 'event', ev, CM)!.earliest)).toBe('2026-10-17 11:00'); // Saturday is fine for an urgent event
  });
  it('no deadline note is sent when the deadline is about to pass', () => {
    expect(followupSlot(cm(15, 11), 'nonResponder', 'event', { kind: 'event', deadlineAt: cm(16, 12) }, CM)).toBeNull();
  });
});

describe('deadline dates', () => {
  it('the owner picks a date; the deadline is the end of that local day', () => {
    const d = endOfLocalDay('2026-10-24', CM)!;
    expect(show(d)).toBe('2026-10-24 23:59');
    expect(localDateString(d, CM)).toBe('2026-10-24');
    expect(endOfLocalDay('nope', CM)).toBeNull();
  });
  it('formats the deadline for the message in the right language', () => {
    expect(formatDeadline(endOfLocalDay('2026-10-24', CM)!, CM, 'en')).toBe('Saturday 24 October');
    expect(formatDeadline(endOfLocalDay('2026-10-24', CM)!, CM, 'fr')).toBe('samedi 24 octobre');
  });
});

describe('template categories', () => {
  it('every reminder-type message is declared MARKETING (owner decision); invitations and gift notices stay UTILITY', async () => {
    const { TEMPLATE_DEFS, TEMPLATE_NAMES } = await import('./wa-messages');
    const reminderish = [TEMPLATE_NAMES.reminder, TEMPLATE_NAMES.nudge, TEMPLATE_NAMES.deadlineNote, TEMPLATE_NAMES.progressSaved, TEMPLATE_NAMES.progressSavedDeadline] as string[];
    const cats = (names: string[]) => TEMPLATE_DEFS.filter((d) => names.includes(d.name)).map((d) => d.category);
    expect(cats(reminderish)).toHaveLength(reminderish.length * 2); // en + fr
    expect(new Set(cats(reminderish))).toEqual(new Set(['MARKETING']));
    expect(new Set(cats([TEMPLATE_NAMES.invitation, TEMPLATE_NAMES.giftNotice]))).toEqual(new Set(['UTILITY']));
  });
});
