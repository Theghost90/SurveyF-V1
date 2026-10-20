import type { FastifyInstance } from 'fastify';
import { rl } from '../lib/ratelimit';
import { buildReceiptPdf } from '../services/receipts';

/** Public (no login): the participant opens it from WhatsApp. The signed token is the credential. */
export default async function receiptRoutes(app: FastifyInstance) {
  app.get('/api/receipts/:token', { ...rl(30) }, async (req, reply) => {
    const r = await buildReceiptPdf((req.params as { token: string }).token);
    // One generic answer for "bad token", "not delivered", "not a paid gift": nothing to learn from the difference.
    if (!r) return reply.code(404).send({ error: 'not_found', message: 'Receipt not found' });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('cache-control', 'private, no-store')
      .send(r.pdf);
  });
}
