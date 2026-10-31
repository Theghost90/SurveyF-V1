import { createHash } from 'node:crypto';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import { env } from '../config/env';

/**
 * API tokens. Short-lived (ACCESS_TOKEN_TTL_SECONDS, 15 minutes by default) and tied to a session row: the API refuses a token whose session was
 * revoked, so "sign out everywhere" and a password change cut off a stolen one immediately (see plugins/auth.ts).
 *
 * Signing keys have ids. The first of JWT_SECRET / JWT_SECRET_PREVIOUS signs; every one of them verifies. Rotating a secret is therefore: move it to
 * JWT_SECRET_PREVIOUS, set a new JWT_SECRET, and after one token lifetime drop the old one. Nobody is signed out by the rotation itself.
 */
const keyId = (secret: string): string => createHash('sha256').update(secret).digest('hex').slice(0, 8);
const ring = env.jwtSecrets.map((secret) => ({ kid: keyId(secret), key: new TextEncoder().encode(secret) }));
const current = ring[0]!;

const ISSUER = 'surveyflow';
const AUDIENCE = 'surveyflow-api';

function keyFor(token: string): Uint8Array {
  const kid = decodeProtectedHeader(token).kid;
  const found = ring.find((k) => k.kid === kid);
  if (!found) throw new Error('unknown signing key');
  return found.key;
}

export async function signAccessToken(userId: string, sessionId: string, ttlSeconds = env.ACCESS_TOKEN_TTL_SECONDS): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256', kid: current.kid })
    .setSubject(userId).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(current.key);
  return { token, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<{ userId: string; sessionId: string }> {
  const { payload } = await jwtVerify(token, keyFor(token), { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
  if (!payload.sub || typeof payload.sid !== 'string') throw new Error('token without subject or session');
  return { userId: payload.sub, sessionId: payload.sid };
}

/** Short-lived signed state for OAuth round-trips (prevents CSRF / account mix-ups). */
export async function signState(purpose: string, userId: string): Promise<string> {
  return new SignJWT({ purpose }).setProtectedHeader({ alg: 'HS256', kid: current.kid }).setSubject(userId).setIssuer(ISSUER).setAudience('surveyflow-state').setExpirationTime('15m').sign(current.key);
}
export async function verifyState(purpose: string, token: string): Promise<string> {
  const { payload } = await jwtVerify(token, keyFor(token), { algorithms: ['HS256'], issuer: ISSUER, audience: 'surveyflow-state' });
  if (payload.purpose !== purpose || !payload.sub) throw new Error('bad state');
  return payload.sub;
}
