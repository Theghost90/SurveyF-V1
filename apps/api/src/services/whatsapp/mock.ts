import { nanoid } from 'nanoid';
import type { OutboundMessage, TemplateDef } from '@surveyflow/shared';
import { redis } from '../../lib/redis';
import type { RemoteTemplate, TemplateSend, WaCreds, WhatsAppGateway } from './gateway';

/**
 * Local stand-in for Meta. Messages are appended to a per-recipient outbox in Redis, which the
 * dashboard's "Simulator" page renders as a WhatsApp chat. Disabled in production by config.
 */
export interface MockOutboxItem {
  id: string;
  at: string;
  direction: 'out' | 'in';
  phoneNumberId: string;
  message?: OutboundMessage;
  template?: TemplateSend;
  /** For inbound items: what the simulated participant "typed" or "tapped". */
  text?: string;
}

export const outboxKey = (waId: string) => `sf:mock:chat:${waId}`;

export async function pushChat(waId: string, item: Omit<MockOutboxItem, 'id' | 'at'> & { id?: string }) {
  const full: MockOutboxItem = { id: item.id ?? `wamid.MOCK${nanoid(14)}`, at: new Date().toISOString(), ...item } as MockOutboxItem;
  await redis.rpush(outboxKey(waId), JSON.stringify(full));
  await redis.ltrim(outboxKey(waId), -300, -1);
  await redis.expire(outboxKey(waId), 7 * 86_400);
  return full;
}

export class MockGateway implements WhatsAppGateway {
  readonly mode = 'mock' as const;

  async sendMessage(creds: WaCreds, to: string, msg: OutboundMessage) {
    const item = await pushChat(to, { direction: 'out', phoneNumberId: creds.phoneNumberId, message: msg });
    return { messageId: item.id };
  }

  async sendTemplate(creds: WaCreds, to: string, t: TemplateSend) {
    const item = await pushChat(to, { direction: 'out', phoneNumberId: creds.phoneNumberId, template: t });
    return { messageId: item.id };
  }

  async createTemplate(_creds: WaCreds, _def: TemplateDef) {
    return { id: `mock-tpl-${nanoid(8)}`, status: 'APPROVED' };
  }

  async listTemplates(): Promise<RemoteTemplate[]> {
    return [];
  }

  async subscribeApp() {}

  async getPhoneInfo(creds: WaCreds) {
    return { displayPhone: creds.phoneNumberId.startsWith('mock-') ? '+237 600 00 00 00 (simulated)' : '', verifiedName: 'Simulated number' };
  }
}
