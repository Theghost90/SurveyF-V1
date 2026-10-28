import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { CUSTOMER_SEGMENTS, normalizePhone, currencyForCountry, phoneExampleFor, supportedCountry } from '@surveyflow/shared';
import { env } from '../config/env';
import { captchaEnabled, verifyCaptcha } from '../lib/captcha';
import { clientIp } from '../lib/client-ip';
import { hit } from '../lib/counters';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { canonicalEmail } from '../lib/email';
import { AppError, badRequest, notFound, unauthorized } from '../lib/errors';
import { detectedCountry } from '../lib/geo';
import { assertPasswordAllowed, hashPassword, verifyPassword } from '../lib/password';
import { prisma } from '../lib/prisma';
import { rl, rlCredentials } from '../lib/ratelimit';
import { matchTotp, newTotpSecret, otpauthUrl } from '../lib/totp';
import { describeAgent } from '../lib/user-agent';
import { accountSummary, userDto } from '../services/account';
import { audit, auditContext, auditStrict, recentActivity } from '../services/audit';
import { track } from '../services/funnel';
import { sendMail, type Lang } from '../services/mail';
import { consumeEmailToken, createEmailToken, peekEmailToken } from '../services/security/email-tokens';
import { ALERT_AT, checkLoginGuard, claimFailedLoginAlert, clearLoginFailures, recordLoginFailure } from '../services/security/login-guard';
import { remainingRecoveryCodes, replaceRecoveryCodes, verifySecondFactor } from '../services/security/second-factor';
import { createSession, isNewDevice, listSessions, refreshSession, revokeAllSessions, revokeSession, type IssuedTokens, type RequestMeta } from '../services/security/sessions';
import { sendStepUpCode, stepUpMethods, verifyStepUp } from '../services/security/step-up';
import { assertWhatsAppConnected } from '../services/whatsapp/require';
import { exploreWindowEnd } from '../services/subscription/lifecycle';
import googleAuthRoutes from './auth-google';

const registerSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(6).max(30),
  password: z.string().min(1).max(128),
  country: z.string().length(2).toUpperCase().optional(),
  locale: z.enum(['fr', 'en']).default('fr'),
  captchaToken: z.string().max(4096).optional(),
  /** The plan picked on the pricing page, carried through the confirmation e-mail to onboarding. */
  plan: z.enum(['starter', 'growth', 'business']).optional(),
  interval: z.enum(['monthly', 'annual']).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  totp: z.string().trim().max(12).optional(),
  recoveryCode: z.string().trim().max(32).optional(),
  captchaToken: z.string().max(4096).optional(),
});

const lang = (l: string | null | undefined): Lang => (l === 'en' ? 'en' : 'fr');
const place = (meta: RequestMeta): string => `${describeAgent(meta.userAgent).label}${meta.ip && meta.ip !== 'unknown' ? `, ${meta.ip.includes(':') ? meta.ip.split(':').slice(0, 3).join(':') + '::' : meta.ip.split('.').slice(0, 3).join('.') + '.x'}` : ''}${meta.country ? ` (${meta.country})` : ''}`;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Where a request came from, for the session row and the notification e-mails. */
export function requestMeta(req: FastifyRequest): RequestMeta {
  return { ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null, country: detectedCountry(req) ?? null };
}

/** A new owner starts on Explore: free, no clock, capped by usage (see PLANS.trial). */
export async function createUserExplore(input: {
  email: string; name: string; businessName: string; phone: string; passwordHash: string | null; country: string; locale: string; emailVerifiedAt?: Date | null;
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
  const auth = { preHandler: app.authenticate };
  const authVerified = { preHandler: app.authenticateVerified };
  const verifyLink = (token: string, kind: 'verify-email' | 'reset-password') => `${env.webBaseUrl}/${kind}?token=${encodeURIComponent(token)}`;

  /** What the web app needs before it draws the sign-in and sign-up forms. Public, and says nothing about any account. */
  app.get('/api/auth/config', async () => ({
    captcha: captchaEnabled() ? { provider: 'turnstile', siteKey: env.TURNSTILE_SITE_KEY } : null,
    emailMode: env.emailProvider === 'mock' ? 'demo' : 'live',
    passwordMinLength: 10,
    googleSignIn: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.INTERNAL_API_SECRET),
  }));

  // ---- sign-up ------------------------------------------------------------------------------------------------------------------------------

  /**
   * Always answers 202 with the same body, whether or not the address already has an account, and does the same amount of work either way
   * (finding 9): a stranger cannot use this form to find out who is a customer. What differs is the e-mail: a new address gets a confirmation link,
   * an address that has an account gets "you already have one".
   * An account whose address was NEVER confirmed does not hold the address: registering again replaces it (finding 1: nobody can squat someone else's address).
   */
  app.post('/api/auth/register', { ...rlCredentials(5) }, async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const meta = requestMeta(req);
    if (!(await verifyCaptcha(body.captchaToken, meta.ip ?? undefined))) throw new AppError(400, 'captcha_failed', 'Please complete the security check and try again');
    if ((await hit(`reg:ip:${meta.ip}`, 3600)) > 20) throw new AppError(429, 'rate_limited', 'Too many sign-ups from this connection. Try again later.');

    // Country follows where the visitor really is (CDN header via the website), then an explicit value, then Cameroon.
    const country = supportedCountry(detectedCountry(req) ?? body.country);
    const phone = normalizePhone(body.phone, country);
    if (!phone) throw badRequest('invalid_phone', `Enter a valid WhatsApp phone number, e.g. ${phoneExampleFor(country)}`);
    await assertPasswordAllowed(body.password, { email: body.email });
    const passwordHash = await hashPassword(body.password); // computed on every path: the time taken must not depend on the address

    const canonical = canonicalEmail(body.email);
    const existing = await prisma.user.findUnique({ where: { emailCanonical: canonical } });
    const ctx = auditContext(req);
    try {
      if (existing?.emailVerifiedAt) {
        // A confirmed account keeps its address. Tell its owner, at most once an hour per mailbox.
        if ((await hit(`reg:exists:${canonical}`, 3600)) === 1) await sendMail(existing.email, 'register_existing', lang(existing.locale), { name: existing.name });
      } else {
        if (existing) {
          await prisma.user.delete({ where: { id: existing.id } }); // never confirmed, so it holds nothing worth keeping (it could not send, pay or export)
          await audit({ ...ctx, userId: existing.id }, { action: 'unverified_account_replaced' });
        }
        const user = await createUserExplore({ email: body.email, name: body.name, businessName: body.businessName, phone, country, locale: body.locale, passwordHash });
        const token = await createEmailToken(user.id, 'verify_email', { ...(body.plan ? { plan: body.plan } : {}), ...(body.interval ? { interval: body.interval } : {}) });
        await sendMail(user.email, 'verify_email', lang(user.locale), { url: verifyLink(token, 'verify-email'), name: user.name });
        await audit({ ...ctx, userId: user.id }, { action: 'register' });
      }
    } catch (err) {
      // Two sign-ups for the same new address at the same instant: the loser is told the same thing as everybody else.
      if (!(err as { code?: string }).code?.startsWith('P2002')) throw err;
    }
    reply.code(202);
    return { ok: true };
  });

  /** Confirms the address behind a link from the e-mail. The link is opened in the browser, but the confirmation is a POST made by a click on the page. */
  app.post('/api/auth/verify-email', { ...rl(20) }, async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const claimed = await consumeEmailToken(token, 'verify_email');
    if (!claimed) throw badRequest('invalid_token', 'This link has expired or was already used. If you already confirmed your address, sign in; otherwise ask for a new link.');
    const user = await prisma.user.update({ where: { id: claimed.userId }, data: { emailVerifiedAt: new Date() } });
    await audit({ ...auditContext(req, user.id) }, { action: 'email_verified' });
    return { ok: true, plan: (claimed.meta.plan as string | undefined) ?? null, interval: (claimed.meta.interval as string | undefined) ?? null };
  });

  /** For someone who closed the tab before confirming: the same generic answer whether or not the address exists. */
  app.post('/api/auth/verify-email/resend', { ...rlCredentials(5) }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), captchaToken: z.string().max(4096).optional() }).parse(req.body);
    const meta = requestMeta(req);
    if (!(await verifyCaptcha(body.captchaToken, meta.ip ?? undefined))) throw new AppError(400, 'captcha_failed', 'Please complete the security check and try again');
    const canonical = canonicalEmail(body.email);
    const user = await prisma.user.findUnique({ where: { emailCanonical: canonical } });
    if (user && !user.emailVerifiedAt && (await hit(`verify:resend:${canonical}`, 3600)) <= 3) {
      await sendMail(user.email, 'verify_email', lang(user.locale), { url: verifyLink(await createEmailToken(user.id, 'verify_email'), 'verify-email'), name: user.name });
      await audit(auditContext(req, user.id), { action: 'verification_resent' });
    }
    reply.code(202);
    return { ok: true };
  });

  /** The signed-in owner asks for a new confirmation link (the "confirm your address" banner). */
  app.post('/api/auth/verification/resend', { ...auth, ...rl(5) }, async (req, reply) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    if (!user.emailVerifiedAt && (await hit(`verify:resend:${canonicalEmail(user.email)}`, 3600)) <= 3) {
      await sendMail(user.email, 'verify_email', lang(user.locale), { url: verifyLink(await createEmailToken(user.id, 'verify_email'), 'verify-email'), name: user.name });
      await audit(auditContext(req), { action: 'verification_resent' });
    }
    reply.code(202);
    return { ok: true };
  });

  // ---- sign-in ------------------------------------------------------------------------------------------------------------------------------

  const tokensDto = (t: IssuedTokens) => ({
    sessionId: t.sessionId, accessToken: t.accessToken, accessTokenExpiresAt: t.accessTokenExpiresAt, refreshToken: t.refreshToken, sessionExpiresAt: t.sessionExpiresAt,
  });

  app.post('/api/auth/login', authLimit, async (req) => {
    const body = loginSchema.parse(req.body);
    const meta = requestMeta(req);
    const ip = meta.ip ?? 'unknown';
    // The counters are keyed by the address with its aliases folded: trying john.doe@ and johndoe@ and j.o.h.n@ must not give three fresh budgets.
    const canonical = canonicalEmail(body.email);
    const guard = await checkLoginGuard(canonical, ip);
    if (guard.retryAfter > 0) throw new AppError(429, 'login_delayed', `Too many attempts. Wait ${guard.retryAfter} seconds before trying again.`, { retryAfter: guard.retryAfter });
    if (guard.captchaRequired && env.captchaEnabled && !(await verifyCaptcha(body.captchaToken, ip))) throw new AppError(403, 'captcha_required', 'Please complete the security check to continue', { captcha: true });

    const user = await prisma.user.findUnique({ where: { emailCanonical: canonical } });
    const check = await verifyPassword(user?.passwordHash ?? null, body.password);
    const fail = async (code: 'invalid_credentials' | 'invalid_code', message: string): Promise<never> => {
      const { accountFailures } = await recordLoginFailure(canonical, ip);
      if (user && accountFailures === ALERT_AT && (await claimFailedLoginAlert(user.id))) {
        await sendMail(user.email, 'failed_logins', lang(user.locale), { count: accountFailures, name: user.name });
        await audit(auditContext(req, user.id), { action: 'login_blocked', meta: { failures: accountFailures } });
      }
      throw new AppError(401, code, message);
    };
    if (!user || !check.ok) return fail('invalid_credentials', 'Invalid email or password');

    // The second factor is asked only after the password was right, so it says nothing about accounts to someone guessing.
    let mfa = false;
    if (user.totpEnabledAt) {
      if (!body.totp && !body.recoveryCode) throw new AppError(401, 'totp_required', 'Enter the code from your authenticator app');
      const how = await verifySecondFactor(user, { totp: body.totp, recoveryCode: body.recoveryCode });
      if (!how) return fail('invalid_code', 'That code did not match');
      if (how === 'recovery') await audit(auditContext(req, user.id), { action: 'recovery_code_used', meta: { left: await remainingRecoveryCodes(user.id) } });
      mfa = true;
    }

    if (check.needsRehash) await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.password) } }); // bcrypt (or weaker argon2) to today's argon2id
    await clearLoginFailures(canonical, ip);
    const fresh = await isNewDevice(user.id, meta);
    const tokens = await createSession(user.id, 'password', mfa, meta);
    const who = { userId: user.id, sessionId: tokens.sessionId, ip, userAgent: meta.userAgent };
    await audit(who, { action: 'login', meta: { mfa } });
    if (fresh) {
      await audit(who, { action: 'login_new_device' });
      await sendMail(user.email, 'new_device', lang(user.locale), { name: user.name, place: place(meta), when: stamp() });
    }
    return { ...tokensDto(tokens), user: userDto(user) };
  });

  /** Trades the refresh token for a new API token (and a new refresh token). Only the website's server calls this; the refresh token never reaches page scripts. */
  app.post('/api/auth/refresh', { ...rl(120) }, async (req) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(20).max(200) }).parse(req.body);
    const ctx = auditContext(req);
    const tokens = await refreshSession(refreshToken, { auditReuse: (userId, sessionId) => audit({ ...ctx, userId, sessionId }, { action: 'refresh_reuse' }) });
    if (!tokens) throw unauthorized('Session ended');
    return tokensDto(tokens);
  });

  app.post('/api/auth/logout', auth, async (req, reply) => {
    await revokeSession(req.sessionId, 'logout');
    await audit(auditContext(req), { action: 'logout' });
    return reply.code(204).send();
  });

  // ---- sessions -----------------------------------------------------------------------------------------------------------------------------

  app.get('/api/auth/sessions', auth, async (req) => ({ items: await listSessions(req.userId, req.sessionId) }));

  app.delete('/api/auth/sessions/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const own = await prisma.authSession.findFirst({ where: { id, userId: req.userId, revokedAt: null }, select: { id: true } });
    if (!own) throw notFound('Session');
    await revokeSession(id, 'revoked_by_owner');
    await audit(auditContext(req), { action: 'session_revoked', targetType: 'session', targetId: id });
    return reply.code(204).send();
  });

  /** "Sign out everywhere". `scope: others` keeps this browser signed in. */
  app.post('/api/auth/sessions/revoke-all', { ...auth, ...rl(10) }, async (req) => {
    const { scope } = z.object({ scope: z.enum(['all', 'others']).default('all') }).parse(req.body ?? {});
    const n = await revokeAllSessions(req.userId, 'sign_out_everywhere', scope === 'others' ? req.sessionId : undefined);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    await audit(auditContext(req), { action: 'sessions_revoked', meta: { count: n, scope } });
    await sendMail(user.email, 'sessions_revoked', lang(user.locale), { name: user.name, when: stamp() });
    return { revoked: n };
  });

  // ---- passwords ----------------------------------------------------------------------------------------------------------------------------

  /** "I forgot my password". The same answer whether or not the address has an account; the e-mail goes only to a real one. */
  app.post('/api/auth/password/forgot', { ...rlCredentials(5) }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), captchaToken: z.string().max(4096).optional() }).parse(req.body);
    const meta = requestMeta(req);
    if (!(await verifyCaptcha(body.captchaToken, meta.ip ?? undefined))) throw new AppError(400, 'captcha_failed', 'Please complete the security check and try again');
    const canonical = canonicalEmail(body.email);
    const user = await prisma.user.findUnique({ where: { emailCanonical: canonical } });
    if (user && (await hit(`reset:${canonical}`, 3600)) <= 3 && (await hit(`reset:ip:${meta.ip}`, 3600)) <= 10) {
      await sendMail(user.email, 'reset_password', lang(user.locale), { url: verifyLink(await createEmailToken(user.id, 'reset_password'), 'reset-password'), name: user.name });
      await audit(auditContext(req, user.id), { action: 'password_reset_requested' });
    }
    reply.code(202);
    return { ok: true };
  });

  /**
   * Sets a new password from the e-mailed link. Reading the link proves the mailbox, so it also confirms the address. Every session is ended (whoever had
   * the old password or a stolen token is out) and the owner is told. An authenticator app, if there is one, still guards the next sign-in.
   */
  app.post('/api/auth/password/reset', { ...rl(10) }, async (req) => {
    const body = z.object({ token: z.string().min(10).max(200), password: z.string().min(1).max(128) }).parse(req.body);
    // Check the password BEFORE the link is used up: a weak choice must not cost the owner their link.
    const peeked = await peekEmailToken(body.token, 'reset_password');
    if (!peeked) throw badRequest('invalid_token', 'This link has expired or was already used. Ask for a new one.');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: peeked.userId } });
    await assertPasswordAllowed(body.password, { email: user.email });
    const claimed = await consumeEmailToken(body.token, 'reset_password');
    if (!claimed) throw badRequest('invalid_token', 'This link has expired or was already used. Ask for a new one.');
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.password), passwordChangedAt: new Date(), emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
    const ended = await revokeAllSessions(user.id, 'password_reset');
    await audit(auditContext(req, user.id), { action: 'password_reset', meta: { sessionsEnded: ended } });
    await sendMail(user.email, 'password_changed', lang(user.locale), { name: user.name, when: stamp() });
    return { ok: true };
  });

  /** Change the password while signed in. Needs the current one; every OTHER session ends. */
  app.post('/api/auth/password/change', { ...auth, ...rl(10) }, async (req) => {
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }).parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    if (!(await verifyPassword(user.passwordHash, body.currentPassword)).ok) {
      await hit(`pwchange:fail:${user.id}`, 900);
      throw new AppError(401, 'invalid_credentials', 'The current password is not right');
    }
    if (body.newPassword === body.currentPassword) throw badRequest('password_unchanged', 'Choose a password different from the current one');
    await assertPasswordAllowed(body.newPassword, { email: user.email });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date() } });
    const ended = await revokeAllSessions(user.id, 'password_changed', req.sessionId);
    await audit(auditContext(req), { action: 'password_changed', meta: { sessionsEnded: ended } });
    await sendMail(user.email, 'password_changed', lang(user.locale), { name: user.name, when: stamp() });
    return { ok: true, sessionsEnded: ended };
  });

  // ---- two-factor (authenticator app) -------------------------------------------------------------------------------------------------------

  /** Step 1: a fresh secret and its QR code. Nothing is on yet; the account is protected only once the first code has been confirmed. */
  app.post('/api/auth/2fa/setup', { ...authVerified, ...rl(10) }, async (req) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    if (user.totpEnabledAt) throw new AppError(409, 'two_factor_already_on', 'Two-factor authentication is already on');
    const secret = newTotpSecret();
    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: encryptSecret(secret), totpLastStep: null } });
    const url = otpauthUrl(secret, user.email);
    // The QR code is drawn here, on the server, as an SVG image: no script from a third party ever sees the secret.
    const qr = `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(url, { type: 'svg', margin: 1, width: 192 })).toString('base64')}`;
    return { secret, otpauthUrl: url, qr };
  });

  /** Step 2: the first code from the app turns it on and returns the recovery codes. This is the only time they are shown. */
  app.post('/api/auth/2fa/enable', { ...authVerified, ...rl(10) }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(6).max(8) }).parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    if (user.totpEnabledAt) throw new AppError(409, 'two_factor_already_on', 'Two-factor authentication is already on');
    if (!user.totpSecret) throw badRequest('two_factor_not_started', 'Start the setup first');
    if ((await hit(`2fa:enable:${user.id}`, 900)) > 10) throw new AppError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
    const step = matchTotp(decryptSecret(user.totpSecret), code);
    if (step === null) throw new AppError(400, 'invalid_code', 'That code did not match. Check the app and try the next code.');
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabledAt: new Date(), totpLastStep: step } });
    const recoveryCodes = await replaceRecoveryCodes(user.id);
    await audit(auditContext(req), { action: 'two_factor_enabled' });
    await sendMail(user.email, 'two_factor_changed', lang(user.locale), { name: user.name, when: stamp(), enabled: true });
    return { enabled: true, recoveryCodes };
  });

  /** Turning it off needs a current code (or a recovery code) AND the password, so a stolen session alone cannot remove the protection. */
  app.post('/api/auth/2fa/disable', { ...auth, ...rl(10) }, async (req) => {
    const body = z.object({ code: z.string().trim().min(6).max(32), password: z.string().max(128).optional() }).parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    if (!user.totpEnabledAt) throw new AppError(409, 'two_factor_off', 'Two-factor authentication is not on');
    if ((await hit(`2fa:disable:${user.id}`, 900)) > 10) throw new AppError(429, 'rate_limited', 'Too many attempts. Wait a few minutes.');
    if (user.passwordHash && !(await verifyPassword(user.passwordHash, body.password ?? '')).ok) throw new AppError(401, 'invalid_credentials', 'The password is not right');
    const ok = await verifySecondFactor(user, body.code.includes('-') ? { recoveryCode: body.code } : { totp: body.code });
    if (!ok) throw new AppError(401, 'invalid_code', 'That code did not match');
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null } }),
      prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    ]);
    await audit(auditContext(req), { action: 'two_factor_disabled' });
    await sendMail(user.email, 'two_factor_changed', lang(user.locale), { name: user.name, when: stamp(), enabled: false });
    return { enabled: false };
  });

  /** A new set of recovery codes (the old ones stop working). Needs a current authenticator code. */
  app.post('/api/auth/2fa/recovery-codes', { ...auth, ...rl(5) }, async (req) => {
    const { code } = z.object({ code: z.string().trim().min(6).max(8) }).parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    if (!user.totpEnabledAt) throw new AppError(409, 'two_factor_off', 'Two-factor authentication is not on');
    if (!(await verifySecondFactor(user, { totp: code }))) throw new AppError(401, 'invalid_code', 'That code did not match');
    const recoveryCodes = await replaceRecoveryCodes(user.id);
    await auditStrict(auditContext(req), { action: 'recovery_codes_regenerated' });
    return { recoveryCodes };
  });

  // ---- "confirm it is you" ------------------------------------------------------------------------------------------------------------------

  app.get('/api/auth/step-up', auth, async (req) => {
    const [user, session] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { totpEnabledAt: true, passwordHash: true, plan: true } }),
      prisma.authSession.findUnique({ where: { id: req.sessionId }, select: { stepUpUntil: true } }),
    ]);
    return { methods: stepUpMethods(user), confirmedUntil: session?.stepUpUntil && session.stepUpUntil > new Date() ? session.stepUpUntil : null, twoFactorRequired: env.require2faPlans.includes(user.plan) && !user.totpEnabledAt };
  });

  app.post('/api/auth/step-up', { ...auth, ...rl(20) }, async (req) => {
    const body = z.object({ method: z.enum(['totp', 'password', 'email_code']), secret: z.string().min(1).max(128) }).parse(req.body);
    const { until } = await verifyStepUp(req, body);
    return { confirmedUntil: until };
  });

  /** Google-only accounts (no password, no authenticator app) confirm with a code e-mailed to them. */
  app.post('/api/auth/step-up/email-code', { ...auth, ...rl(10) }, async (req, reply) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
    await sendStepUpCode(req, user);
    reply.code(202);
    return { ok: true };
  });

  // ---- the owner's own security overview ----------------------------------------------------------------------------------------------------

  app.get('/api/auth/security', auth, async (req) => {
    const [user, google, codes] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: req.userId } }),
      prisma.authIdentity.count({ where: { userId: req.userId, provider: 'google' } }),
      remainingRecoveryCodes(req.userId),
    ]);
    return {
      emailVerified: !!user.emailVerifiedAt, twoFactorEnabled: !!user.totpEnabledAt, hasPassword: !!user.passwordHash, googleLinked: google > 0,
      recoveryCodesLeft: user.totpEnabledAt ? codes : null, passwordChangedAt: user.passwordChangedAt,
      twoFactorRequired: env.require2faPlans.includes(user.plan) && !user.totpEnabledAt,
    };
  });

  app.get('/api/auth/activity', auth, async (req) => ({ items: await recentActivity(req.userId) }));

  // ---- profile ------------------------------------------------------------------------------------------------------------------------------

  /**
   * Country / currency follow the owner's location UNTIL their first successful payment, then they are locked: a price (and a PSP
   * currency) that changes under a paying customer — say, a trip abroad — would break renewals and invoices.
   */
  async function syncCountry(req: FastifyRequest) {
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

  app.get('/api/auth/me', auth, async (req) => {
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

  app.patch('/api/auth/me', auth, async (req) => {
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

  await app.register(googleAuthRoutes);

}
