import type { OutboundMessage, SurveyLang, TemplateDef } from '@surveyflow/shared';
import { env } from '../../config/env';
import { CloudApiGateway } from './cloud';
import { MockGateway } from './mock';

export interface WaCreds {
  phoneNumberId: string;
  wabaId: string;
  /** Decrypted access token — never persist or log this. */
  accessToken: string;
}

export interface TemplateSend {
  name: string;
  language: SurveyLang;
  bodyParams: string[];
  /** Payload of each quick-reply button, in order (e.g. "START:<surveyId>"). */
  buttonPayloads: string[];
  /** Suffix for each URL button, in order (they follow the quick-reply buttons), e.g. the receipt token. */
  urlParams?: string[];
}

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  reason?: string;
  /** What Meta says the category is now (it may differ from what was submitted). */
  category?: string;
}

/** A WhatsApp API failure, classified so callers can retry transient ones and give up on the rest. */
export class WaError extends Error {
  constructor(
    message: string,
    public code?: number,
    public transient = false,
    /** Account-level problem (expired token, revoked permission). */
    public accountFault = false,
  ) {
    super(message);
  }
}

export interface WhatsAppGateway {
  readonly mode: 'mock' | 'live';
  sendMessage(creds: WaCreds, toWaId: string, msg: OutboundMessage): Promise<{ messageId: string }>;
  sendTemplate(creds: WaCreds, toWaId: string, t: TemplateSend): Promise<{ messageId: string }>;
  createTemplate(creds: WaCreds, def: TemplateDef): Promise<{ id: string; status: string }>;
  listTemplates(creds: WaCreds): Promise<RemoteTemplate[]>;
  subscribeApp(creds: WaCreds): Promise<void>;
  getPhoneInfo(creds: WaCreds): Promise<{ displayPhone: string; verifiedName?: string }>;
}

let instance: WhatsAppGateway | null = null;
export function getGateway(): WhatsAppGateway {
  if (!instance) instance = env.waMode === 'live' ? new CloudApiGateway() : new MockGateway();
  return instance;
}
/** Test hook. */
export function setGateway(g: WhatsAppGateway | null) {
  instance = g;
}
