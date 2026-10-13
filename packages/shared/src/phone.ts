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
