import { toWaId } from '@surveyflow/shared';
import { prisma } from '../lib/prisma';
import { platformCreds } from './whatsapp/accounts';
import { getGateway } from './whatsapp/gateway';

/**
 * Platform → owner notices from SurveyFlow's own WhatsApp number (WHATSAPP_PHONE_NUMBER_ID).
 * Best effort: a free-form message only reaches the owner if they messaged that number in the last 24h; a
 * production-grade version needs an approved template (not part of the V1 template library). Never throws.
 */
export async function notifyOwner(userId: string, text: string): Promise<void> {
  const creds = platformCreds();
  if (!creds) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
  if (!user?.phone) return;
  try {
    await getGateway().sendMessage(creds, toWaId(user.phone), { kind: 'text', body: text });
  } catch {
    /* outside the 24h window or number not reachable: in-app status is the source of truth */
  }
}
