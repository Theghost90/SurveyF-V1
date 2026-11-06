import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { supportedCountry } from '@surveyflow/shared';
import { env } from '../config/env';
import { hit } from '../lib/counters';
import { canonicalEmail } from '../lib/email';
import { AppError, badRequest, notFound } from '../lib/errors';
import { detectedCountry } from '../lib/geo';
import { prisma } from '../lib/prisma';
import { rl } from '../lib/ratelimit';
import { audit, auditContext } from '../services/audit';
import { sendMail } from '../services/mail';
import { consumeEmailToken, createEmailToken } from '../services/security/email-tokens';
import { createSession, isNewDevice } from '../services/security/sessions';
import { userDto } from '../services/account';
import { createUserExplore, requestMeta } from './auth';

/**
 * Sign in with Google (finding 6, and the rules set out with it).
 *
 *  - The API checks the ID token ITSELF: Google's signature, the issuer, OUR client id as audience, expiry, and `email_verified`. The website's word that
 *    "Google said so" is not trusted, and the old endpoint that minted a session for any e-mail address, guarded only by one shared secret, no longer exists.
 *  - A Google account is recognised by Google's stable subject id (provider + sub), never by its e-mail address alone: an address can be reassigned or
 *    changed, the subject cannot.
 *  - A NEW Google user gets an account at once (Google has verified the address).
 *  - An address that already has a PASSWORD account is never merged silently. If that account's address was never confirmed it is a squatter and is replaced;
 *    if it was confirmed, the owner gets an e-mail link and the two are linked only when they click it.
 *  - Everything is off unless GOOGLE_CLIENT_ID is configured.
 * Google sign-in does not ask for the SurveyFlow authenticator code (Google's own sign-in protections apply); step-up checks for exports still do.
 */
const googleOn = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.INTERNAL_API_SECRET);

const remote = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
let resolver: JWTVerifyGetKey | undefined;
/** Tests inject a local key set here; nothing else should. */
export const setGoogleKeyResolver = (r: JWTVerifyGetKey | undefined): void => { resolver = r; };

export interface GoogleIdentity { sub: string; email: string; name: string }

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, resolver ?? remote, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: env.GOOGLE_CLIENT_ID!, algorithms: ['RS256'] });
  if (payload.email_verified !== true) throw new Error('Google has not verified this e-mail address');
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('token without subject or e-mail');
  return { sub: payload.sub, email: payload.email.trim().toLowerCase(), name: typeof payload.name === 'string' ? payload.name : '' };
}

export default async function googleAuthRoutes(app: FastifyInstance) {
  app.post('/api/auth/google', { ...rl(30) }, async (req, reply) => {
    if (!googleOn()) throw notFound('Route');
    const { idToken } = z.object({ idToken: z.string().min(20).max(8192) }).parse(req.body);
    let g: GoogleIdentity;
    try { g = await verifyGoogleIdToken(idToken); } catch { throw new AppError(401, 'invalid_google_token', 'Google sign-in could not be verified'); }

    const meta = requestMeta(req);
    const known = await prisma.authIdentity.findUnique({ where: { provider_subject: { provider: 'google', subject: g.sub } }, include: { user: true } });
    let user = known?.user ?? null;

    if (!user) {
      const canonical = canonicalEmail(g.email);
      const existing = await prisma.user.findUnique({ where: { emailCanonical: canonical } });
      if (existing?.emailVerifiedAt) {
        // A confirmed account is the owner's: it is linked only with proof of the mailbox, never because Google says the address matches.
        if ((await hit(`gl:link:${canonical}`, 3600)) <= 3) {
          const token = await createEmailToken(existing.id, 'link_google', { provider: 'google', sub: g.sub, email: g.email });
          await sendMail(existing.email, 'link_google', existing.locale === 'en' ? 'en' : 'fr', { url: `${env.webBaseUrl}/link-google?token=${encodeURIComponent(token)}`, name: existing.name });
          await audit(auditContext(req, existing.id), { action: 'google_link_requested' });
        }
        reply.code(202);
        return { status: 'link_required' };
      }
      if (existing) {
        // Never confirmed: whoever registered it never proved the address, and Google just proved it for someone else. The registration is dropped.
        await prisma.user.delete({ where: { id: existing.id } });
        await audit(auditContext(req, existing.id), { action: 'unverified_account_replaced' });
      }
      user = await createUserExplore({
        email: g.email, name: g.name || g.email.split('@')[0]!, businessName: g.name || 'My business', phone: '', passwordHash: null,
        country: supportedCountry(detectedCountry(req)), locale: 'fr', emailVerifiedAt: new Date(),
      });
      await prisma.authIdentity.create({ data: { userId: user.id, provider: 'google', subject: g.sub, email: g.email } });
    }

    const fresh = await isNewDevice(user.id, meta);
    const tokens = await createSession(user.id, 'google', false, meta);
    const who = { userId: user.id, sessionId: tokens.sessionId, ip: meta.ip, userAgent: meta.userAgent };
    await audit(who, { action: 'google_login' });
    if (fresh) {
      await audit(who, { action: 'login_new_device' });
      await sendMail(user.email, 'new_device', user.locale === 'en' ? 'en' : 'fr', { name: user.name, place: `${meta.userAgent ? 'a browser' : 'a device'}${meta.ip ? `, ${meta.ip}` : ''}`, when: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' });
    }
    return { status: 'ok', sessionId: tokens.sessionId, accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshToken: tokens.refreshToken, sessionExpiresAt: tokens.sessionExpiresAt, user: userDto(user) };
  });

  /** The owner clicked the link in the "link your Google account" e-mail. After this, signing in with that Google account opens this account. */
  app.post('/api/auth/google/link/confirm', { ...rl(20) }, async (req) => {
    if (!googleOn()) throw notFound('Route');
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const claimed = await consumeEmailToken(token, 'link_google');
    const sub = claimed?.meta.sub;
    if (!claimed || typeof sub !== 'string') throw badRequest('invalid_token', 'This link has expired or was already used. Try signing in with Google again.');
    const taken = await prisma.authIdentity.findUnique({ where: { provider_subject: { provider: 'google', subject: sub } } });
    if (taken && taken.userId !== claimed.userId) throw new AppError(409, 'identity_in_use', 'This Google account is already linked to another SurveyFlow account');
    if (!taken) await prisma.authIdentity.create({ data: { userId: claimed.userId, provider: 'google', subject: sub, email: typeof claimed.meta.email === 'string' ? claimed.meta.email : null } });
    await audit(auditContext(req, claimed.userId), { action: 'google_linked' });
    return { ok: true };
  });
}
