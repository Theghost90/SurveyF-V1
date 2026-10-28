import { randomInt } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import { env } from '../../config/env';
import { clear, hit } from '../../lib/counters';
import { keyedHash, safeEqual } from '../../lib/crypto';
import { AppError } from '../../lib/errors';
import { verifyPassword } from '../../lib/password';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { audit, auditContext } from '../audit';
import { sendMail } from '../mail';
import { markStepUp } from './sessions';
import { verifySecondFactor } from './second-factor';

/**
 * "Confirm it is you" (finding 4): before participant data leaves the account in bulk (a large export, a bulk delete), a stolen session is not enough.
 * The owner re-proves who they are with whatever they have: the authenticator code, else the password, else a code e-mailed to them (Google-only accounts).
 * The proof lasts STEP_UP_MINUTES for that session only. Owners on the plans in REQUIRE_2FA_PLANS (Business) must have an authenticator app turned on first.
 */
export type StepUpMethod = 'totp' | 'password' | 'email_code';

export const stepUpMethods = (u: Pick<User, 'totpEnabledAt' | 'passwordHash'>): StepUpMethod[] =>
  u.totpEnabledAt ? ['totp'] : u.passwordHash ? ['password'] : ['email_code'];

const codeKey = (sessionId: string) => `sf:sucode:${sessionId}`;

/** Throws unless this session has confirmed recently. Cheap when it has. */
export async function assertStepUp(req: FastifyRequest): Promise<void> {
  const [session, user] = await Promise.all([
    prisma.authSession.findUnique({ where: { id: req.sessionId }, select: { stepUpUntil: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { plan: true, totpEnabledAt: true, passwordHash: true } }),
  ]);
  if (env.require2faPlans.includes(user.plan) && !user.totpEnabledAt) {
    throw new AppError(403, 'two_factor_required', 'Turn on two-factor authentication (Settings, Security) to download or delete participant data on this plan', { setup: true });
  }
  if (session?.stepUpUntil && session.stepUpUntil > new Date()) return;
  throw new AppError(403, 'step_up_required', 'Confirm it is you to continue', { methods: stepUpMethods(user) });
}

export async function sendStepUpCode(req: FastifyRequest, user: Pick<User, 'id' | 'email' | 'locale'>): Promise<void> {
  if (!(await hit(`su:send:${req.sessionId}`, 600).then((n) => n <= 3))) throw new AppError(429, 'rate_limited', 'Too many codes requested. Wait a few minutes.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); // digits only, easy to retype
  await redis.set(codeKey(req.sessionId), keyedHash('stepup-code', `${req.sessionId}:${code}`), 'EX', 600);
  await clear(`su:codefail:${req.sessionId}`); // a fresh code gets a fresh five tries (the session-wide limit in verifyStepUp still applies)
  await sendMail(user.email, 'step_up_code', user.locale === 'fr' ? 'fr' : 'en', { code, name: undefined });
}

async function checkEmailCode(sessionId: string, code: string): Promise<boolean> {
  const stored = await redis.get(codeKey(sessionId));
  if (!stored) return false;
  if ((await hit(`su:codefail:${sessionId}`, 600)) > 5) { await redis.del(codeKey(sessionId)); return false; }
  const ok = safeEqual(stored, keyedHash('stepup-code', `${sessionId}:${code.replace(/\s/g, '')}`));
  if (ok) await redis.del(codeKey(sessionId));
  return ok;
}

/** Checks the proof and, if it holds, opens the window. Throws 401 `invalid_step_up` otherwise (five tries per 15 minutes per session). */
export async function verifyStepUp(req: FastifyRequest, input: { method: StepUpMethod; secret: string }): Promise<{ until: Date }> {
  if ((await hit(`su:fail:${req.sessionId}`, 900)) > 8) throw new AppError(429, 'rate_limited', 'Too many attempts. Wait a few minutes and try again.');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  if (!stepUpMethods(user).includes(input.method)) throw new AppError(400, 'invalid_step_up_method', 'That way of confirming is not available for this account');
  let ok = false;
  if (input.method === 'totp') ok = (await verifySecondFactor(user, input.secret.includes('-') ? { recoveryCode: input.secret } : { totp: input.secret })) !== null;
  else if (input.method === 'password') ok = (await verifyPassword(user.passwordHash, input.secret)).ok;
  else ok = await checkEmailCode(req.sessionId, input.secret);
  if (!ok) {
    await audit(auditContext(req), { action: 'step_up_failed', meta: { method: input.method } });
    throw new AppError(401, 'invalid_step_up', 'That did not match. Check it and try again.');
  }
  const until = new Date(Date.now() + env.STEP_UP_MINUTES * 60_000);
  await markStepUp(req.sessionId, until);
  await audit(auditContext(req), { action: 'step_up', meta: { method: input.method } });
  return { until };
}
