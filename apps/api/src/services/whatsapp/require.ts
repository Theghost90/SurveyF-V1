import { conflict } from '../../lib/errors';
import { prisma } from '../../lib/prisma';

/**
 * Everything that touches the owner's WhatsApp Business number (surveys, contacts, sending, top-ups) needs that number connected first.
 * One check, one error code (`whatsapp_not_connected`), so the website can answer every case with the same "finish connecting" screen.
 */
export async function assertWhatsAppConnected(userId: string): Promise<void> {
  if (!(await prisma.whatsAppAccount.count({ where: { userId, status: 'active' } }))) {
    throw conflict('whatsapp_not_connected', 'Finish connecting your WhatsApp Business number first.');
  }
}
