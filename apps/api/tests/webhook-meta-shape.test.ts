import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { buildWorld, chatOf, makeApp, postWebhook, resetAll, templateBtn, waIdOf } from './helpers';

/**
 * WA-01: the shape of a REAL inbound message, copied field for field from the payload Meta's own webhook log
 * showed for a "HI" sent to the test number (2026-11-03, webhook fields configured at v26.0). It carries fields
 * the handler does not read (from_user_id, user_id, country_code, from_logical_id, internal_1p_only_data).
 * The handler must accept it, ignore the extras, and keep working if Meta adds more.
 */

const WABA = '1117818397522042';

/** The extras Meta put on a real message and on its contact entry. */
const realExtras = {
  from_user_id: 'CM.4493892657497625',
  from_logical_id: '125782462582961',
  internal_1p_only_data: { account_context: { waac_id: '1814873496385157', cs_id: '1451675338030914', account_context_type: 'non_paid_messaging' } },
};
const realContact = (waId: string) => ({ profile: { name: 'Djousse Candice' }, wa_id: waId, user_id: 'CM.4493892657497625', country_code: 'CM' });

function realPayload(phoneNumberId: string, waId: string, message: Record<string, unknown>, extraChanges: Array<{ field: string; value: unknown }> = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: WABA,
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15551708350', phone_number_id: phoneNumberId },
            contacts: [realContact(waId)],
            messages: [{ ...message, from: waId, timestamp: '1793722578', ...realExtras }],
          },
        },
        ...extraChanges,
      ],
    }],
  };
}

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });

describe('Meta v26.0 real message shape', () => {
  it('accepts the real "HI" from a number that is not a participant and answers 200 without doing anything', async () => {
    const w = await buildWorld(app);
    const res = await postWebhook(app, realPayload(w.phoneNumberId, '23776277298', { id: 'wamid.HBgLMjM3NzYyNzcyOTgVAgASGBYzRUIwRjFEN0Q4MUQ2NEIxODMyNkQ1AA==', type: 'text', text: { body: 'HI' } }));
    expect(res.statusCode).toBe(200);
    expect(await prisma.surveyRecipient.count({ where: { status: 'started' } })).toBe(0);
  });

  it('still runs the survey when a participant\'s message carries the extra fields (template button START)', async () => {
    const w = await buildWorld(app);
    const btn = templateBtn(waIdOf(0), `START:${w.surveyId}`);
    const res = await postWebhook(app, realPayload(w.phoneNumberId, waIdOf(0), { id: btn.id, type: btn.type, button: btn.button }));
    expect(res.statusCode).toBe(200);
    expect((await prisma.surveyRecipient.findFirst({ where: { contactId: w.contactIds[0] } }))!.status).toBe('started');
    expect((await chatOf(0)).at(-1).message.body).toContain('Question 1 of 3');
  });

  it('ignores fields it does not handle that Meta has switched on (calls, security, account_update, an unknown future one) and still answers 200', async () => {
    const w = await buildWorld(app);
    const others = ['calls', 'security', 'account_update', 'account_alerts', 'phone_number_quality_update', 'message_template_quality_update', 'some_field_from_the_future']
      .map((field) => ({ field, value: { anything: { at: ['all'] }, event: 'X' } }));
    const res = await postWebhook(app, realPayload(w.phoneNumberId, '23776277298', { id: 'wamid.X1', type: 'text', text: { body: 'HI' } }, others));
    expect(res.statusCode).toBe(200);
  });

  it('survives a message type it has never seen (a v26 type with unknown keys) without a 500, which would make Meta retry forever', async () => {
    const w = await buildWorld(app);
    const res = await postWebhook(app, realPayload(w.phoneNumberId, waIdOf(0), { id: 'wamid.X2', type: 'a_new_type', a_new_type: { nested: { x: 1 } } }));
    expect(res.statusCode).toBe(200);
  });
});
