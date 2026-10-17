import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { rlCredentials } from '../lib/ratelimit';
import { z } from 'zod';
import { CUSTOMER_SEGMENTS, normalizePhone, currencyForCountry, phoneExampleFor, supportedCountry } from '@surveyflow/shared';
import { env } from '../config/env';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
import { detectedCountry } from '../lib/geo';
import { signAccessToken } from '../lib/jwt';
import { safeEqual } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { accountSummary, userDto } from '../services/account';
import { track } from '../services/funnel';
import { assertWhatsAppConnected } from '../services/whatsapp/require';
import { exploreWindowEnd } from '../services/subscription/lifecycle';

const registerSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(6).max(30),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  country: z.string().length(2).toUpperCase().optional(),
  locale: z.enum(['fr', 'en']).default('fr'),
});

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

// A fixed hash so unknown-email logins cost the same as wrong-password ones (no user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

/** A new owner starts on Explore: free, no clock, capped by usage (see PLANS.trial). */
export async function createUserExplore(input: {
  email: string; name: string; businessName: string; phone: string; passwordHash: string | null; country: string; locale: string;
}) {
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      ...input,
      plan: 'trial',
      preferredCurrency: currencyForCountry(input.country),
      subscription: { create: { plan: 'trial', status: 'trial', currentPeriodStart: now, currentPeriodEnd: exploreWindowEnd(now), amountFCFA: 0 } },
    },
  });
  await track(user.id, 'signup');
  return user;
}

export default async function authRoutes(app: FastifyInstance) {
  const authLimit = rlCredentials(10);

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    // Country follows where the visitor really is (CDN header via the website), then an explicit value, then Cameroon.
    const country = supportedCountry(detectedCountry(req) ?? body.country);
    const phone = normalizePhone(body.phone, country);
    if (!phone) throw badRequest('invalid_phone', `Enter a valid WhatsApp phone number, e.g. ${phoneExampleFor(country)}`);
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw conflict('email_taken', 'An account with this email already exists');

    const user = await createUserExplore({
      email: body.email, name: body.name, businessName: body.businessName, phone, country, locale: body.locale,
      passwordHash: await bcrypt.hash(body.password, 12),
    });
    reply.code(201);
    return { token: await signAccessToken(user.id), user: userDto(user) };
  });

  app.post('/api/auth/login', authLimit, async (req) => {
    const body = loginSchema.parse(req.body);
    // Per-ACCOUNT failure budget, independent of IP: rotating IPs must not allow unlimited guessing of one account.
    const failKey = `sf:loginfail:${body.email}`;
    if (Number((await redis.get(failKey)) ?? 0) >= 30) throw new AppError(429, 'rate_limited', 'Too many failed attempts for this account. Try again in 15 minutes.');
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !ok) {
      const n = await redis.incr(failKey);
      if (n === 1) await redis.expire(failKey, 15 * 60);
      throw unauthorized('Invalid email or password');
    }
    await redis.del(failKey);
    return { token: await signAccessToken(user.id), user: userDto(user) };
  });

  /**
   * Google sign-in. Called server-to-server by NextAuth after Google verified the
   * identity; protected by a shared secret so nobody else can mint sessions.
   */
  app.post('/api/auth/oauth', async (req) => {
    if (!env.INTERNAL_API_SECRET) throw forbidden('OAuth sign-in is not enabled');
    const given = String(req.headers['x-internal-secret'] ?? '');
    if (!safeEqual(given, env.INTERNAL_API_SECRET)) throw forbidden();
    const body = z.object({ email: z.string().toLowerCase().email(), name: z.string().min(1).max(120).default('') }).parse(req.body);
    let user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      user = await createUserExplore({
        email: body.email, name: body.name || body.email.split('@')[0]!, businessName: body.name || 'My business',
        phone: '', passwordHash: null, country: supportedCountry(undefined), locale: 'fr',
      });
    }
    return { token: await signAccessToken(user.id), user: userDto(user) };
  });

  /**
   * Country / currency follow the owner's location UNTIL their first successful payment, then they are locked: a price (and a PSP
   * currency) that changes under a paying customer — say, a trip abroad — would break renewals and invoices.
   */
  async function syncCountry(req: import('fastify').FastifyRequest) {
    const seen = detectedCountry(req);
    if (!seen) return;
    const country = supportedCountry(seen);
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { country: true, giftCurrency: true } });
    if (!user || user.country === country) return;
    // Locked once money has moved: a paid plan, a wallet in some currency, or a top-up in flight must never change currency under the owner.
    if (user.giftCurrency) return;
    if (await prisma.paymentTransaction.count({ where: { userId: req.userId, OR: [{ status: 'success' }, { status: 'pending', purpose: 'gift_topup' }] } })) return;
    await prisma.user.update({ where: { id: req.userId }, data: { country, preferredCurrency: currencyForCountry(country) } });
  }

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => {
    await syncCountry(req);
    return accountSummary(req.userId);
  });

  // No country / currency / payment provider here by design: country is detected, currency follows it, and the payment
  // provider is chosen silently per payment (owners are never asked about any of them).
  const profileSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    businessName: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    locale: z.enum(['fr', 'en']).optional(),
    segment: z.enum(CUSTOMER_SEGMENTS).optional(),
    onboardingDone: z.boolean().optional(),
  });

  app.patch('/api/auth/me', { preHandler: app.authenticate }, async (req) => {
    const body = profileSchema.parse(req.body);
    const current = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    let phone = current.phone;
    if (body.phone !== undefined) {
      const p = normalizePhone(body.phone, current.country);
      if (!p) throw badRequest('invalid_phone', `Enter a valid phone number, e.g. ${phoneExampleFor(current.country)}`);
      phone = p;
    }
    // The one required answer of onboarding: setup cannot be marked done without it.
    if (body.onboardingDone && !(body.segment ?? current.segment)) throw badRequest('segment_required', 'Choose your customer segment to finish setup');
    if (body.onboardingDone) await assertWhatsAppConnected(req.userId); // the two required steps of setup: segment, then the WhatsApp number
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        name: body.name, businessName: body.businessName, locale: body.locale, segment: body.segment, phone,
        ...(body.onboardingDone ? { onboardingDoneAt: new Date() } : {}),
      },
    });
    if (body.onboardingDone) await track(req.userId, 'onboarding_done');
    return { user: userDto(user) };
  });
}
