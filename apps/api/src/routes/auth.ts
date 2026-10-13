import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { rl } from '../lib/ratelimit';
import { z } from 'zod';
import { TRIAL_DAYS, normalizePhone, currencyForCountry, COUNTRY_CONFIG, DEFAULT_COUNTRY } from '@surveyflow/shared';
import { env } from '../config/env';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
import { signAccessToken } from '../lib/jwt';
import { safeEqual } from '../lib/crypto';
import { prisma } from '../lib/prisma';
import { accountSummary, userDto } from '../services/account';

const registerSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(6).max(30),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  country: z.string().length(2).toUpperCase().default(DEFAULT_COUNTRY),
  locale: z.enum(['fr', 'en']).default('fr'),
});

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

// A fixed hash so unknown-email logins cost the same as wrong-password ones (no user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

export async function createUserWithTrial(input: {
  email: string; name: string; businessName: string; phone: string; passwordHash: string | null; country: string; locale: string;
}) {
  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
  return prisma.user.create({
    data: {
      ...input,
      plan: 'trial',
      preferredCurrency: currencyForCountry(input.country),
      trialEndsAt: trialEnd,
      subscription: { create: { plan: 'trial', status: 'trial', currentPeriodStart: now, currentPeriodEnd: trialEnd, amountFCFA: 0 } },
    },
  });
}

export default async function authRoutes(app: FastifyInstance) {
  const authLimit = rl(10);

  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const country = COUNTRY_CONFIG[body.country] ? body.country : DEFAULT_COUNTRY;
    const phone = normalizePhone(body.phone, country);
    if (!phone) throw badRequest('invalid_phone', 'Enter a valid WhatsApp phone number, e.g. +237 677 12 34 56');
    if (await prisma.user.findUnique({ where: { email: body.email } })) throw conflict('email_taken', 'An account with this email already exists');

    const user = await createUserWithTrial({
      email: body.email, name: body.name, businessName: body.businessName, phone, country, locale: body.locale,
      passwordHash: await bcrypt.hash(body.password, 12),
    });
    reply.code(201);
    return { token: await signAccessToken(user.id), user: userDto(user) };
  });

  app.post('/api/auth/login', authLimit, async (req) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    const ok = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !ok) throw unauthorized('Invalid email or password');
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
      user = await createUserWithTrial({
        email: body.email, name: body.name || body.email.split('@')[0]!, businessName: body.name || 'My business',
        phone: '', passwordHash: null, country: DEFAULT_COUNTRY, locale: 'fr',
      });
    }
    return { token: await signAccessToken(user.id), user: userDto(user) };
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => accountSummary(req.userId));

  const profileSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    businessName: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    locale: z.enum(['fr', 'en']).optional(),
    country: z.string().length(2).toUpperCase().optional(),
    preferredPSP: z.enum(['notchpay', 'cinetpay', 'campay', 'payunit', 'flutterwave']).nullable().optional(),
    onboardingDone: z.boolean().optional(),
  });

  app.patch('/api/auth/me', { preHandler: app.authenticate }, async (req) => {
    const body = profileSchema.parse(req.body);
    const current = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    const country = body.country && COUNTRY_CONFIG[body.country] ? body.country : current.country;
    let phone = current.phone;
    if (body.phone !== undefined) {
      const p = normalizePhone(body.phone, country);
      if (!p) throw badRequest('invalid_phone', 'Enter a valid phone number');
      phone = p;
    }
    const user = await prisma.user.update({
      where: { id: req.userId },
      data: {
        name: body.name, businessName: body.businessName, locale: body.locale, preferredPSP: body.preferredPSP,
        phone, country, preferredCurrency: currencyForCountry(country),
        ...(body.onboardingDone ? { onboardingDoneAt: new Date() } : {}),
      },
    });
    return { user: userDto(user) };
  });
}
