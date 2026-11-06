import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readMockMailbox } from '../services/mail';

/**
 * Demo and development only (registered when EMAIL_PROVIDER=mock outside production): the e-mails the mock provider "sent", so a tester can open the
 * confirmation link without a real mailbox. It is reachable only through the website (the internal gate) and holds mail for two hours.
 */
export default async function mailboxRoutes(app: FastifyInstance) {
  app.get('/api/dev/mailbox', async (req) => {
    const { to } = z.object({ to: z.string().trim().toLowerCase().email() }).parse(req.query);
    return { items: await readMockMailbox(to) };
  });
}
