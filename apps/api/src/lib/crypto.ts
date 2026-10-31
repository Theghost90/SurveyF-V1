import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Encryption at rest.
 *
 * A KEY RING: every ciphertext names the key that made it (`v2.<kid>.<iv>.<tag>.<data>`), new data is always written with the first key of the ring, and
 * old keys stay in the ring until nothing uses them any more (scripts/rotate-keys.mts re-encrypts). Payloads written before the ring existed
 * (`v1.<iv>.<tag>.<data>`, TOKEN_ENCRYPTION_KEY) are still read. AES-256-GCM, with the key id as authenticated data so a payload cannot be re-labelled.
 */
interface Key { kid: string; key: Buffer }

function parseKey(raw: string, what: string): Buffer {
  const asHex = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : null;
  const key = asHex ?? Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error(`${what} must decode to exactly 32 bytes`);
  return key;
}

/**
 * The original single key. Derived from a constant outside production, so a fresh checkout works without any secret. In production without it (a new
 * deploy that only sets ENCRYPTION_KEYS) it is random per process: nothing written by an older version exists there, and a published constant must never
 * be able to open anything.
 */
function loadLegacyKey(): Buffer {
  if (!env.TOKEN_ENCRYPTION_KEY) return env.isProd ? randomBytes(32) : scryptSync('surveyflow-dev-only-encryption-key', 'sf-salt', 32);
  return parseKey(env.TOKEN_ENCRYPTION_KEY, 'TOKEN_ENCRYPTION_KEY');
}

function loadRing(legacy: Buffer): { active: Key; byKid: Map<string, Key> } {
  const byKid = new Map<string, Key>();
  let active: Key | undefined;
  for (const part of (env.ENCRYPTION_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const kid = part.slice(0, i);
    if (i < 1 || !/^[A-Za-z0-9_-]{1,16}$/.test(kid)) throw new Error('ENCRYPTION_KEYS must look like "kid:key,kid:key" (kid: letters, digits, - or _, at most 16)');
    if (byKid.has(kid)) throw new Error(`ENCRYPTION_KEYS: key id "${kid}" appears twice`);
    const k = { kid, key: parseKey(part.slice(i + 1), `ENCRYPTION_KEYS (${kid})`) };
    byKid.set(kid, k);
    active ??= k;
  }
  if (!active) { active = { kid: 'k1', key: legacy }; byKid.set('k1', active); }
  return { active, byKid };
}

const LEGACY_KEY = loadLegacyKey();
const RING = loadRing(LEGACY_KEY);

export const activeKeyId = (): string => RING.active.kid;

/** Encrypts a secret for storage with the active key. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const { kid, key } = RING.active;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(kid));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v2', kid, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, iv, tag, data] = parts as [string, string, string, string, string];
    const k = RING.byKid.get(kid);
    if (!k) throw new Error(`No encryption key "${kid}" in ENCRYPTION_KEYS: it was removed while data still uses it`);
    const decipher = createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(kid));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
  if (parts[0] === 'v1' && parts.length === 4) {
    const [, iv, tag, data] = parts as [string, string, string, string];
    const decipher = createDecipheriv('aes-256-gcm', LEGACY_KEY, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
  throw new Error('Unrecognised secret format');
}

/** True for anything that is not a current-format ciphertext under the active key: plain text, a v1 payload, or a retired key. */
export const needsReEncryption = (payload: string): boolean => !payload.startsWith(`v2.${RING.active.kid}.`) || !CIPHERTEXT_V2.test(payload);
/** The exact shape of our ciphertexts (12-byte IV = 16 characters, 16-byte tag = 22): a plain name that merely starts with "v2." is not mistaken for one. */
const CIPHERTEXT_V2 = /^v2\.[A-Za-z0-9_-]{1,16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
const CIPHERTEXT_V1 = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
export const isCiphertext = (payload: string): boolean => CIPHERTEXT_V2.test(payload) || CIPHERTEXT_V1.test(payload);

/** A value that is stored encrypted but may still be plain text from before the encryption existed (until the start-up backfill has run). */
export function decryptIfEncrypted(value: string): string {
  return isCiphertext(value) ? decryptSecret(value) : value;
}

// ---- keyed hashes ---------------------------------------------------------------------------------------------------------------------------

/** 32 bytes derived from BLIND_INDEX_KEY (a constant outside production). The secret is not the encryption key: leaking one must not give the other. */
const INDEX_KEY: Buffer = env.BLIND_INDEX_KEY ? parseKey(env.BLIND_INDEX_KEY, 'BLIND_INDEX_KEY') : scryptSync('surveyflow-dev-only-blind-index-key', 'sf-index-salt', 32);

/**
 * "Can I find this number again without being able to read it?" HMAC-SHA256 with a secret key: the same input always gives the same value (so a number
 * can be looked up and kept unique), but without the key a database leak cannot be turned back into numbers by trying all of them (there are only
 * about a billion).
 */
export function blindIndex(namespace: string, value: string): string {
  return createHmac('sha256', INDEX_KEY).update(`${namespace}:${value}`).digest('hex');
}

/** A subkey for one purpose (recovery codes, step-up codes), derived from the JWT secret so no extra secret has to be configured. */
const subkeys = new Map<string, Buffer>();
export function subkey(purpose: string): Buffer {
  let k = subkeys.get(purpose);
  if (!k) { k = Buffer.from(hkdfSync('sha256', env.jwtSecret, 'surveyflow', `sf-subkey:${purpose}`, 32)); subkeys.set(purpose, k); }
  return k;
}
export const keyedHash = (purpose: string, value: string): string => createHmac('sha256', subkey(purpose)).update(value).digest('hex');

// ---- small helpers --------------------------------------------------------------------------------------------------------------------------

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hmacHex(secret: string, data: Buffer | string, algo: 'sha256' | 'sha512' = 'sha256'): string {
  return createHmac(algo, secret).update(data).digest('hex');
}

/** Unambiguous alphabet (no 0/O/1/I/L) for codes people read out or retype. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateDiscountCode(prefix = 'SF'): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** `length` characters from the unambiguous alphabet (recovery codes). */
export function randomCode(length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
