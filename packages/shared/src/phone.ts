import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Canonical stored form: E.164 with a leading "+", e.g. "+237677123456".
 * Meta's webhook `from` field is the same number WITHOUT the plus — use
 * `toWaId` / `fromWaId` at that boundary, never ad-hoc string slicing.
 */
export function normalizePhone(raw: string, defaultCountry: string = 'CM'): string | null {
  const cleaned = (raw ?? '').trim().replace(/[\s().-]/g, '');
  if (!cleaned) return null;
  // Meta-style digits-only input that already carries a country code ("2376...")
  const candidates = cleaned.startsWith('+') ? [cleaned] : cleaned.startsWith('00') ? ['+' + cleaned.slice(2)] : [cleaned];
  for (const c of candidates) {
    const parsed = parsePhoneNumberFromString(c, defaultCountry as CountryCode);
    if (parsed?.isValid()) return parsed.number;
  }
  if (!cleaned.startsWith('+')) {
    const parsed = parsePhoneNumberFromString('+' + cleaned);
    if (parsed?.isValid()) return parsed.number;
  }
  return null;
}

export const toWaId = (e164: string): string => e164.replace(/\D/g, '');
export const fromWaId = (waId: string): string => '+' + waId.replace(/\D/g, '');

/**
 * The number as Meta reports it on an INBOUND message (`from`, `contacts[].wa_id`) can be spelled differently from the one the owner imported and we send to.
 * Seen on a real phone (2026-11-04): imported and dialled as +237 676 277 298 (12 digits), reported by Meta as 23776277298 (11 digits). Cameroon moved its mobile
 * numbers from 8 to 9 digits by putting a 6 in front, and WhatsApp still reports the old form for this account while accepting the new one for sending. Left as it
 * is, such a sender matches no imported contact and no linked owner phone: the message is dropped without an error.
 *
 * Deliberately narrow: it changes a number only when (a) it starts with 237 and has exactly 11 digits, (b) the number as received is NOT valid, and (c) putting a 6
 * after 237 makes it valid. Anything else comes back unchanged (digits only, no plus). Based on one real number and on the numbering plan as the phone library has it;
 * other operators' old-format numbers are assumed to behave the same and have not been seen.
 */
export function canonicalWaId(waId: string): string {
  const d = (waId ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('237') && !parsePhoneNumberFromString('+' + d)?.isValid()) {
    const withSix = '2376' + d.slice(3);
    if (parsePhoneNumberFromString('+' + withSix)?.isValid()) return withSix;
  }
  return d;
}

/** "+237677123456" -> "+237 6XX XXX 456" (matches the dashboard mockups). */
export function maskPhone(e164: string): string {
  const d = toWaId(e164);
  if (d.length < 8) return e164;
  const cc = d.startsWith('237') ? '237' : d.slice(0, 3);
  const rest = d.slice(cc.length);
  return `+${cc} ${rest[0]}XX XXX ${rest.slice(-3)}`;
}

export function formatPhone(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}
