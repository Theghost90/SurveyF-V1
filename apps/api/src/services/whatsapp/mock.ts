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

/** Keyed by the business number AND the participant: one phone may be surveyed by several businesses. */
export const outboxKey = (phoneNumberId: string, waId: string) => `sf:mock:chat:${phoneNumberId}:${waId}`;

export async function pushChat(waId: string, item: Omit<MockOutboxItem, 'id' | 'at'> & { id?: string }) {
  const full: MockOutboxItem = { id: item.id ?? `wamid.MOCK${nanoid(14)}`, at: new Date().toISOString(), ...item } as MockOutboxItem;
  const key = outboxKey(full.phoneNumberId, waId);
  await redis.rpush(key, JSON.stringify(full));
  await redis.ltrim(key, -300, -1);
  await redis.expire(key, 7 * 86_400);
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

  /** Simulated numbers whose id starts with `mock-app-` stand for a number that is in a WhatsApp Business app (Mireille); the others are new numbers (Armand). */
  async getAppStatus(creds: WaCreds) {
    if (!creds.phoneNumberId.startsWith('mock-')) return { isOnBizApp: null, platformType: null };
    return { isOnBizApp: creds.phoneNumberId.startsWith('mock-app-'), platformType: 'CLOUD_API' };
  }

  async listPhoneNumbers() {
    return [];
  }

  async registerPhone(creds: WaCreds, pin: string) {
    mockCalls.push({ at: new Date().toISOString(), op: 'register', phoneNumberId: creds.phoneNumberId, detail: `pin:${pin.length}` });
  }

  async requestAppDataSync(creds: WaCreds, syncType: 'smb_app_state_sync' | 'history') {
    mockCalls.push({ at: new Date().toISOString(), op: `sync:${syncType}`, phoneNumberId: creds.phoneNumberId });
    return { requestId: `mock-req-${nanoid(6)}` };
  }
}

/** What the mock was asked to do that has no chat to show (register, sync): the tests read it, the real Meta would have done it. */
export const mockCalls: Array<{ at: string; op: string; phoneNumberId: string; detail?: string }> = [];
