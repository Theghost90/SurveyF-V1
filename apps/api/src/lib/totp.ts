import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Authenticator-app codes (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the format Google Authenticator, Microsoft Authenticator, Authy and 1Password
 * all read. No dependency: it is a page of arithmetic and the RFC publishes test vectors that the tests use.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=-]/g, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpAt(secretBase32: string, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepNow = (nowMs = Date.now()): number => Math.floor(nowMs / 30_000);

/** The time step a code is valid for (within one step either side, for clock drift), or null. A step that was already used is the caller's check. */
export function matchTotp(secretBase32: string, code: string, nowMs = Date.now()): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = stepNow(nowMs);
  for (const step of [now, now - 1, now + 1]) {
    if (step < 0) continue; // only near the epoch (a clock set to 1970), but a negative counter would throw
    const expected = totpAt(secretBase32, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, account: string, issuer = 'SurveyFlow'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
