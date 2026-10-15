import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { describe, expect, it } from 'vitest';
import {
  COUNTRY_CONFIG, DEFAULT_COUNTRY, PAID_PLAN_KEYS, PLAN_PRICES, abandonerSlot, addBusinessDays, alignToSendWindow, closingNoteFor, countryWithCurrency,
  currencyForCountry, dialPrefix, endOfLocalDay, followupSlot, formatDeadline, formatPrice, localDateString, nonResponderSlot, overagePerBlock, rankByFee,
  supportedCountry, usesEventRule, type Currency,
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
  it('every supported country has a price for every paid plan in its currency', () => {
    for (const c of Object.values(COUNTRY_CONFIG)) for (const plan of PAID_PLAN_KEYS) expect(PLAN_PRICES[plan][c.currency as Currency], `${c.name} ${plan}`).toBeGreaterThan(0);
  });
});

describe('prices in the visitor currency', () => {
  it('formats FCFA the product way and other currencies with their own style', () => {
    expect(formatPrice(14500, 'XAF')).toBe('14,500 FCFA');
    expect(formatPrice(14500, 'XOF', 'fr')).toBe('14\u202f500 FCFA');
    expect(formatPrice(23, 'USD')).toBe('$23');
    expect(formatPrice(35000, 'NGN')).toMatch(/35,000/);
  });
  it('scales the overage block per currency (2 significant digits) and keeps 500 FCFA', () => {
    expect(overagePerBlock('XAF')).toBe(500);
    expect(overagePerBlock('XOF')).toBe(500);
    expect(overagePerBlock('USD')).toBeCloseTo(0.79, 2);
    expect(overagePerBlock('NGN')).toBe(1200);
  });
});

describe('PSP ranking by configured fee', () => {
  it('cheapest first; PSPs with an unknown fee keep their configured order after the known ones', () => {
    const fees = { notchpay: { mobile_money: 2.5 }, flutterwave: { mobile_money: 1.5 } };
    expect(rankByFee(['campay', 'notchpay', 'payunit', 'flutterwave'], 'mobile_money', fees)).toEqual(['flutterwave', 'notchpay', 'campay', 'payunit']);
    expect(rankByFee(['campay', 'notchpay'], 'mobile_money', {})).toEqual(['campay', 'notchpay']);
    expect(rankByFee(['a', 'b'] as never, 'card', { a: { mobile_money: 1 } } as never)).toEqual(['a', 'b']); // fee known only for another method
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
