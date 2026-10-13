import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env';

const secret = new TextEncoder().encode(env.jwtSecret);

export async function signAccessToken(userId: string, ttl = '12h'): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt().setIssuer('surveyflow').setExpirationTime(ttl).sign(secret);
}

export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], issuer: 'surveyflow' });
  if (!payload.sub) throw new Error('token without subject');
  return payload.sub;
}

/** Short-lived signed state for OAuth round-trips (prevents CSRF / account mix-ups). */
export async function signState(purpose: string, userId: string): Promise<string> {
  return new SignJWT({ purpose }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setExpirationTime('15m').sign(secret);
}
export async function verifyState(purpose: string, token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  if (payload.purpose !== purpose || !payload.sub) throw new Error('bad state');
  return payload.sub;
}
