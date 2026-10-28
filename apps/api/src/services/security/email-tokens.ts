import { randomToken, sha256Hex } from '../../lib/crypto';
import { prisma } from '../../lib/prisma';

/**
 * One-time links sent by e-mail. The raw token exists only in the e-mail: the database keeps its SHA-256, so a database leak cannot be used to verify an
 * address, reset a password or link an account. A token works once, until it expires, and only for the purpose it was made for.
 */
export type TokenPurpose = 'verify_email' | 'reset_password' | 'link_google';

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  verify_email: 24 * 3_600_000,
  reset_password: 30 * 60_000,
  link_google: 30 * 60_000,
};

export async function createEmailToken(userId: string, purpose: TokenPurpose, meta?: Record<string, string | number | boolean>): Promise<string> {
  // A new link of the same kind replaces the older ones: only the latest e-mail works.
  await prisma.emailToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
  const raw = randomToken(32);
  await prisma.emailToken.create({ data: { userId, purpose, tokenHash: sha256Hex(raw), meta: meta ?? undefined, expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]) } });
  return raw;
}

/** Reads a token without using it up (so a form can be validated before the link is spent). Null when it is not usable. */
export async function peekEmailToken(raw: string, purpose: TokenPurpose): Promise<{ userId: string } | null> {
  if (!raw || raw.length > 200) return null;
  const row = await prisma.emailToken.findFirst({ where: { tokenHash: sha256Hex(raw), purpose, usedAt: null, expiresAt: { gt: new Date() } }, select: { userId: true } });
  return row;
}

/** Marks the token used and returns who it was for, or null (unknown, wrong purpose, expired or already used: the caller cannot and need not tell which). */
export async function consumeEmailToken(raw: string, purpose: TokenPurpose): Promise<{ userId: string; meta: Record<string, unknown> } | null> {
  if (!raw || raw.length > 200) return null;
  const tokenHash = sha256Hex(raw);
  const claimed = await prisma.emailToken.updateMany({ where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) return null;
  const row = await prisma.emailToken.findUniqueOrThrow({ where: { tokenHash } });
  return { userId: row.userId, meta: (row.meta as Record<string, unknown> | null) ?? {} };
}

export async function invalidateEmailTokens(userId: string, purpose: TokenPurpose): Promise<void> {
  await prisma.emailToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
}
