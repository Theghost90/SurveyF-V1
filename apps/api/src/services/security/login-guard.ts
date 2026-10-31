import { sha256Hex } from '../../lib/crypto';
import { clear, hit, peek } from '../../lib/counters';
import { redis } from '../../lib/redis';

/**
 * Brute-force defence (finding 5), as rising delays and a CAPTCHA, never a lock-out: a lock would let a stranger stop a customer from signing in.
 *
 * Three counters, none of which says whether the address exists (they are keyed by a hash of whatever was typed):
 *   pair     failures for this address from this IP, 15 minutes    from the 5th: wait 2, 4, 8, 16, 32, then 60 seconds between attempts, and a CAPTCHA
 *   account  failures for this address from anywhere, 1 hour       from the 10th: a CAPTCHA for everybody (an attacker rotating IPs), and the owner is e-mailed
 *   ip       failures from this IP across addresses, 10 minutes    from the 20th: a CAPTCHA (credential stuffing)
 * The legitimate owner on their usual connection is not slowed by someone else's guessing from another IP, only asked for a CAPTCHA.
 */
const PAIR_WINDOW = 15 * 60;
const ACCOUNT_WINDOW = 3600;
const IP_WINDOW = 10 * 60;
export const PAIR_FREE = 4; // failures before the delays begin
const ACCOUNT_CAPTCHA = 10;
const IP_CAPTCHA = 20;

const h = (email: string) => sha256Hex(email.trim().toLowerCase()).slice(0, 32);
const pairKey = (email: string, ip: string) => `lf:pair:${h(email)}|${ip}`;
const lastKey = (email: string, ip: string) => `sf:lfl:${h(email)}|${ip}`;

export interface GuardState { captchaRequired: boolean; retryAfter: number; accountFailures: number }

export const delaySeconds = (failures: number): number => (failures <= PAIR_FREE ? 0 : Math.min(60, 2 ** (failures - PAIR_FREE)));

export async function checkLoginGuard(email: string, ip: string): Promise<GuardState> {
  const [pair, account, ipFails, last] = await Promise.all([
    peek(pairKey(email, ip)), peek(`lf:acct:${h(email)}`), peek(`lf:ip:${ip}`), redis.get(lastKey(email, ip)),
  ]);
  const wait = delaySeconds(pair) * 1000 - (Date.now() - Number(last ?? 0));
  return {
    captchaRequired: pair > PAIR_FREE || account >= ACCOUNT_CAPTCHA || ipFails >= IP_CAPTCHA,
    retryAfter: pair > PAIR_FREE && wait > 0 ? Math.ceil(wait / 1000) : 0,
    accountFailures: account,
  };
}

/** Counts a failure. Returns how many failures this ADDRESS has had in the hour (the caller e-mails the owner when it crosses the threshold). */
export async function recordLoginFailure(email: string, ip: string): Promise<{ accountFailures: number }> {
  await Promise.all([hit(pairKey(email, ip), PAIR_WINDOW), hit(`lf:ip:${ip}`, IP_WINDOW)]);
  await redis.set(lastKey(email, ip), String(Date.now()), 'EX', PAIR_WINDOW);
  return { accountFailures: await hit(`lf:acct:${h(email)}`, ACCOUNT_WINDOW) };
}

export const ALERT_AT = ACCOUNT_CAPTCHA;

/** A successful sign-in forgives this address and this IP's recent failures for it (not the IP-wide count: one good login must not reset a stuffing attack). */
export async function clearLoginFailures(email: string, ip: string): Promise<void> {
  await clear(pairKey(email, ip), `lf:acct:${h(email)}`);
  await redis.del(lastKey(email, ip));
}

/** At most one "someone is guessing your password" e-mail per owner every six hours. */
export async function claimFailedLoginAlert(userId: string): Promise<boolean> {
  return (await redis.set(`sf:lfalert:${userId}`, '1', 'EX', 6 * 3600, 'NX')) === 'OK';
}
