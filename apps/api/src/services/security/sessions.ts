import { randomBytes } from 'node:crypto';
import type { AuthSession } from '@prisma/client';
import { env } from '../../config/env';
import { ipPrefix } from '../../lib/client-ip';
import { sha256Hex, safeEqual } from '../../lib/crypto';
import { signAccessToken } from '../../lib/jwt';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { describeAgent } from '../../lib/user-agent';

/**
 * Sign-in sessions (finding 3). Every signed-in browser is a row in AuthSession. The API token names the row, and a row that is revoked or expired kills
 * the token on its next use (a one-minute cache in Redis keeps this off the database, and revoking deletes the cache entry at once).
 *
 * The browser also holds a refresh token. It is rotated every time it is used; the previous one is honoured for REFRESH_GRACE_MS so that two requests
 * refreshing at the same moment do not look like theft, and a previous token used after that means a copy of the cookie is in two places: the session is
 * ended.
 */
const REFRESH_GRACE_MS = 30_000;
const CACHE_SECONDS = 60;

export interface RequestMeta { ip?: string | null; userAgent?: string | null; country?: string | null }

export interface IssuedTokens {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  /** null when the caller must keep the refresh token it already has (the grace-window answer). */
  refreshToken: string | null;
  sessionExpiresAt: string;
}

const refreshToken = (sessionId: string, secret: string) => `rt_${sessionId}_${secret}`;
export function parseRefreshToken(raw: string): { sessionId: string; secret: string } | null {
  const m = /^rt_([A-Za-z0-9]{20,40})_([A-Za-z0-9_-]{40,64})$/.exec(raw);
  return m ? { sessionId: m[1]!, secret: m[2]! } : null;
}

const cacheKey = (sid: string) => `sf:sess:${sid}`;

export const deviceKeyFor = (meta: RequestMeta): string => {
  const a = describeAgent(meta.userAgent);
  return sha256Hex(`${a.browser}|${a.system}|${meta.country ?? '?'}`).slice(0, 32);
};

async function accessFor(session: Pick<AuthSession, 'id' | 'userId' | 'expiresAt'>) {
  const remaining = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
  return signAccessToken(session.userId, session.id, Math.max(30, Math.min(env.ACCESS_TOKEN_TTL_SECONDS, remaining)));
}

export async function createSession(userId: string, method: 'password' | 'google', mfa: boolean, meta: RequestMeta): Promise<IssuedTokens> {
  const secret = randomBytes(36).toString('base64url');
  const session = await prisma.authSession.create({
    data: {
      // 128 random bits, not a cuid: the id sits inside the refresh token and the API token, and a guessable id would let a stranger aim a wrong refresh token at it.
      id: randomBytes(16).toString('hex'), userId, method, mfa, refreshHash: sha256Hex(secret), deviceKey: deviceKeyFor(meta), userAgent: (meta.userAgent ?? '').slice(0, 300) || null,
      ipPrefix: ipPrefix(meta.ip), country: meta.country ?? null, expiresAt: new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000),
    },
  });
  const access = await accessFor(session);
  return { sessionId: session.id, accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), refreshToken: refreshToken(session.id, secret), sessionExpiresAt: session.expiresAt.toISOString() };
}

/** True when this (browser, system, country) has not signed this owner in during the last 90 days. The very first sign-in is not "new". */
export async function isNewDevice(userId: string, meta: RequestMeta): Promise<boolean> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const [known, any] = await Promise.all([
    prisma.authSession.count({ where: { userId, deviceKey: deviceKeyFor(meta), createdAt: { gt: since } } }),
    prisma.authSession.count({ where: { userId } }),
  ]);
  return any > 0 && known === 0;
}

/** Trades a refresh token for new tokens. Returns null when the session is over (revoked, expired, unknown) or the token was replayed. */
export async function refreshSession(raw: string, ctx: { auditReuse?: (userId: string, sessionId: string) => Promise<void> } = {}): Promise<IssuedTokens | null> {
  const parsed = parseRefreshToken(raw);
  if (!parsed) return null;
  const session = await prisma.authSession.findUnique({ where: { id: parsed.sessionId } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
  const given = sha256Hex(parsed.secret);

  if (safeEqual(given, session.refreshHash)) {
    const secret = randomBytes(36).toString('base64url');
    // Compare-and-set: of two refreshes racing with the same token, one rotates and the other falls into the grace branch below.
    const rotated = await prisma.authSession.updateMany({
      where: { id: session.id, refreshHash: session.refreshHash, revokedAt: null },
      data: { prevRefreshHash: session.refreshHash, rotatedAt: new Date(), refreshHash: sha256Hex(secret), lastUsedAt: new Date() },
    });
    if (rotated.count === 1) {
      const access = await accessFor(session);
      return { sessionId: session.id, accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), refreshToken: refreshToken(session.id, secret), sessionExpiresAt: session.expiresAt.toISOString() };
    }
    return refreshSession(raw, ctx); // somebody rotated between our read and write: re-read and take the grace path
  }

  if (session.prevRefreshHash && safeEqual(given, session.prevRefreshHash) && session.rotatedAt && Date.now() - session.rotatedAt.getTime() <= REFRESH_GRACE_MS) {
    // A parallel request refreshed a moment ago. Give this one a fresh API token but NOT a new refresh token: the browser keeps whichever the winner set.
    const access = await accessFor(session);
    return { sessionId: session.id, accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString(), refreshToken: null, sessionExpiresAt: session.expiresAt.toISOString() };
  }

  // An old refresh token, long after it was replaced: the cookie was copied. End the session.
  await revokeSession(session.id, 'refresh_reuse');
  await ctx.auditReuse?.(session.userId, session.id);
  return null;
}

/** The session behind an API token, if it is still good. Cached for a minute; revoking clears the cache. */
export async function activeSession(sessionId: string, userId: string): Promise<boolean> {
  const cached = await redis.get(cacheKey(sessionId));
  if (cached) return cached === userId;
  const s = await prisma.authSession.findFirst({ where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
  if (!s) return false;
  await redis.set(cacheKey(sessionId), userId, 'EX', CACHE_SECONDS);
  return true;
}

export async function revokeSession(sessionId: string, reason: string): Promise<boolean> {
  const r = await prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  await redis.del(cacheKey(sessionId));
  return r.count > 0;
}

/** Ends every session of the owner (optionally all but one). Returns how many were ended. */
export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const live = await prisma.authSession.findMany({ where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) }, select: { id: true } });
  if (!live.length) return 0;
  await prisma.authSession.updateMany({ where: { id: { in: live.map((s) => s.id) }, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  await redis.del(...live.map((s) => cacheKey(s.id)));
  return live.length;
}

export async function listSessions(userId: string, currentSessionId?: string) {
  const rows = await prisma.authSession.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: 'desc' }, take: 50 });
  return rows.map((s) => ({
    id: s.id, current: s.id === currentSessionId, device: describeAgent(s.userAgent).label, place: [s.ipPrefix, s.country].filter(Boolean).join(' · ') || null,
    method: s.method, mfa: s.mfa, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt,
  }));
}

export async function touchSession(sessionId: string): Promise<void> {
  await prisma.authSession.updateMany({ where: { id: sessionId }, data: { lastUsedAt: new Date() } });
}

export async function markStepUp(sessionId: string, until: Date): Promise<void> {
  await prisma.authSession.updateMany({ where: { id: sessionId, revokedAt: null }, data: { stepUpUntil: until } });
}
