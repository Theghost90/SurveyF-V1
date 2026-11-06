import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';
import { hmacHex, safeEqual } from '../lib/crypto';
import { processWebhookPayload } from '../services/survey/handler';

export default async function webhookRoutes(app: FastifyInstance) {
  /** Meta verification handshake (hub.mode, hub.verify_token, hub.challenge). */
  app.get('/api/webhook/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && q['hub.verify_token'] && safeEqual(q['hub.verify_token'], env.WHATSAPP_VERIFY_TOKEN)) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send('Forbidden');
  });

  app.post('/api/webhook/whatsapp', async (req, reply) => {
    // The spec's handler trusts any POST. Without verifying X-Hub-Signature-256 anyone who finds the URL
    // can forge participants' answers (and trigger gift payouts). Reject unsigned requests.
    if (env.META_APP_SECRET) {
      const header = String(req.headers['x-hub-signature-256'] ?? '');
      const expected = 'sha256=' + hmacHex(env.META_APP_SECRET, req.rawBody ?? Buffer.alloc(0));
      if (!header || !safeEqual(header, expected)) return reply.code(401).send({ error: 'invalid_signature' });
    } else if (env.waMode === 'live' || env.isProd) {
      req.log.error('META_APP_SECRET missing: refusing unsigned webhook');
      return reply.code(401).send({ error: 'webhook_not_configured' });
    }

    try {
      await processWebhookPayload(req.body, req.log);
    } catch (err) {
      // Non-2xx makes Meta retry later; per-message idempotency makes the retry safe.
      req.log.error({ err }, 'webhook processing failed');
      return reply.code(500).send({ error: 'processing_failed' });
    }
    return reply.code(200).send({ ok: true });
  });
}
