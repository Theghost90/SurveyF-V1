import { env } from '../config/env';

/**
 * Holds a response until at least AUTH_MIN_RESPONSE_MS have passed since `startedAt`. Used by the three endpoints that must not reveal whether an address has an
 * account (sign-up, resend the confirmation, forgot password): they already give the same answer, and this makes the time they take the same too, so the
 * database work that only a real address costs cannot be measured from outside. (The e-mail itself is sent in the background for the same reason.)
 */
export async function padResponse(startedAt: number, minMs: number = env.AUTH_MIN_RESPONSE_MS): Promise<void> {
  const wait = minMs - (Date.now() - startedAt);
  if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
}
