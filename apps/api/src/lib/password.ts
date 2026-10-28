import { createHash } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { AppError } from './errors';
import { isCommonPassword } from './common-passwords';

/**
 * Passwords.
 *
 * argon2id (memory-hard, runs on the thread pool so it never freezes the server, no 72-byte limit). Accounts created before this existed hold a bcrypt
 * hash: it still verifies, and the account is moved to argon2id the next time its owner signs in (`needsRehash`).
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export const hashPassword = (plain: string): Promise<string> =>
  argonHash(plain, { algorithm: 2 /* argon2id */, memoryCost: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST, parallelism: 1 });

export interface PasswordCheck { ok: boolean; needsRehash: boolean }

/** `hash` null (no such account, or a Google-only account) still does the same amount of work, so timing does not tell a stranger which e-mails exist. */
export async function verifyPassword(hash: string | null, plain: string): Promise<PasswordCheck> {
  const stored = hash ?? (await dummyHash());
  let ok = false;
  let legacy = false;
  try {
    if (stored.startsWith('$argon2')) ok = await argonVerify(stored, plain);
    else { legacy = true; ok = await bcrypt.compare(plain, stored); }
  } catch { ok = false; }
  return { ok: ok && hash !== null, needsRehash: ok && hash !== null && (legacy || weakerThanCurrent(stored)) };
}

/** An argon2 hash made with cheaper settings than today's (the settings are in the hash itself). */
function weakerThanCurrent(h: string): boolean {
  const m = /\$m=(\d+),t=(\d+),p=/.exec(h);
  return !!m && (Number(m[1]) < env.ARGON2_MEMORY_KIB || Number(m[2]) < env.ARGON2_TIME_COST);
}

// Made as soon as the module loads, so the first unknown-address sign-in does not pay for it and stand out.
const dummy: Promise<string> = hashPassword('not-a-real-password-for-timing');
const dummyHash = () => dummy;

// ---- the policy -----------------------------------------------------------------------------------------------------------------------------

export type PasswordProblem = 'password_too_short' | 'password_too_long' | 'password_too_common' | 'password_contains_email' | 'password_breached';

const MESSAGES: Record<PasswordProblem, string> = {
  password_too_short: `Use at least ${MIN_PASSWORD_LENGTH} characters`,
  password_too_long: `Use at most ${MAX_PASSWORD_LENGTH} characters`,
  password_too_common: 'This password is too easy to guess. Choose something less common',
  password_contains_email: 'Your password must not contain your e-mail address',
  password_breached: 'This password appeared in a data breach. Choose a different one',
};

/** Rules that need no network: length, the most common passwords, and not being your own address. */
export function localPasswordProblem(plain: string, ctx: { email?: string } = {}): PasswordProblem | null {
  if ([...plain].length < MIN_PASSWORD_LENGTH) return 'password_too_short';
  if (plain.length > MAX_PASSWORD_LENGTH) return 'password_too_long';
  if (isCommonPassword(plain)) return 'password_too_common';
  const local = ctx.email?.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 5 && plain.toLowerCase().includes(local)) return 'password_contains_email';
  return null;
}

/** The haveibeenpwned range API. Only the first five characters of the SHA-1 leave the server, the rest is compared here. Fails open (a slow or down service never blocks sign-up). */
export async function isBreachedPassword(plain: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const sha1 = createHash('sha1').update(plain).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'SurveyFlow' }, signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    for (const line of (await res.text()).split(/\r?\n/)) {
      const [s, count] = line.split(':');
      if (s?.trim().toUpperCase() === suffix && Number(count) > 0) return true; // padding rows carry a count of 0
    }
    return false;
  } catch {
    return false;
  }
}

/** Throws a 400 with a stable code the web app translates. `fetchImpl` is injectable for tests. */
export async function assertPasswordAllowed(plain: string, ctx: { email?: string } = {}, fetchImpl?: typeof fetch): Promise<void> {
  const problem = localPasswordProblem(plain, ctx) ?? (env.hibpEnabled && (await isBreachedPassword(plain, fetchImpl)) ? 'password_breached' : null);
  if (problem) throw new AppError(400, problem, MESSAGES[problem]);
}
