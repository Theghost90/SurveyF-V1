import type { User } from '@prisma/client';
import { decryptSecret, randomCode, sha256Hex } from '../../lib/crypto';
import { prisma } from '../../lib/prisma';
import { matchTotp } from '../../lib/totp';

/**
 * The authenticator-app second factor: checking a code, and the recovery codes that stand in for it when the phone is lost.
 * A code is accepted once: `totpLastStep` only ever moves forward (compare-and-set), so a code that was watched over a shoulder or intercepted cannot be replayed.
 */
export const RECOVERY_CODE_COUNT = 10;

/**
 * XXXX-XXXX-XXXX-XXXX from an alphabet without 0/O/1/I: about 80 bits of randomness, which is why a plain SHA-256 is enough in the database (nobody can try 2^80
 * codes, even with the table in hand). Deliberately NOT a keyed hash: a key would have to survive for as long as any code does, and rotating a secret (JWT_SECRET
 * is meant to be rotated) would then silently invalidate every owner's recovery codes, to be discovered on the day the phone is lost.
 */
export const newRecoveryCode = (): string => [randomCode(4), randomCode(4), randomCode(4), randomCode(4)].join('-');
const normaliseRecovery = (c: string): string => c.replace(/[\s-]/g, '').toUpperCase();
const recoveryHash = (c: string): string => sha256Hex(`recovery-code:${normaliseRecovery(c)}`);

/** A fresh set of recovery codes. The old ones stop working. Returns the codes: this is the only time they are visible. */
export async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId } }),
    prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: recoveryHash(c) })) }),
  ]);
  return codes;
}

/** True when the code is the current authenticator code and has not been used. */
export async function checkTotp(user: Pick<User, 'id' | 'totpSecret' | 'totpLastStep'>, code: string): Promise<boolean> {
  if (!user.totpSecret) return false;
  const step = matchTotp(decryptSecret(user.totpSecret), code);
  if (step === null) return false;
  const claimed = await prisma.user.updateMany({
    where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step },
  });
  return claimed.count === 1;
}

/** Uses a recovery code: true once, never again. */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const used = await prisma.recoveryCode.updateMany({ where: { userId, codeHash: recoveryHash(code), usedAt: null }, data: { usedAt: new Date() } });
  return used.count === 1;
}

export const remainingRecoveryCodes = (userId: string): Promise<number> => prisma.recoveryCode.count({ where: { userId, usedAt: null } });

export type SecondFactorInput = { totp?: string; recoveryCode?: string };

export async function verifySecondFactor(user: Pick<User, 'id' | 'totpSecret' | 'totpLastStep'>, input: SecondFactorInput): Promise<'totp' | 'recovery' | null> {
  if (input.totp && (await checkTotp(user, input.totp))) return 'totp';
  if (input.recoveryCode && (await consumeRecoveryCode(user.id, input.recoveryCode))) return 'recovery';
  return null;
}
