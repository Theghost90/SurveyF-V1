import type { OutboundMessage, TemplateDef } from '@surveyflow/shared';
import { env } from '../../config/env';
import { WaError, type RemoteTemplate, type TemplateSend, type WaCreds, type WhatsAppGateway } from './gateway';

/**
 * Meta WhatsApp Business Cloud API client (Graph API).
 * Written against Meta's public documentation; it has NOT been exercised against a
 * live WABA from this environment (no credentials / egress) — run the sandbox checklist
 * in README before going live.
 */

// Error codes worth retrying (rate limits / throughput / temporary outages).
const TRANSIENT = new Set([1, 2, 4, 17, 32, 341, 613, 80007, 130429, 131056, 133004, 133005]);
// Token / permission problems: the whole account needs attention, not just this message.
const ACCOUNT_FAULT = new Set([10, 190, 200, 368, 131031]);

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
}

export class CloudApiGateway implements WhatsAppGateway {
  readonly mode = 'live' as const;
  private base = `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

  private async call<T>(path: string, token: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
    const url = new URL(`${this.base}/${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Timeout / DNS / connection reset: we do not know whether Meta accepted it.
      throw new WaError(`network error: ${(err as Error).message}`, undefined, true);
    }
    const json = (await res.json().catch(() => ({}))) as T & GraphError;
    if (!res.ok || json.error) {
      const code = json.error?.code;
      const detail = json.error?.error_data?.details ?? json.error?.message ?? res.statusText;
      throw new WaError(`${code ?? res.status}: ${detail}`, code, res.status >= 500 || (code !== undefined && TRANSIENT.has(code)), code !== undefined && ACCOUNT_FAULT.has(code));
    }
    return json;
  }

  private async send(creds: WaCreds, payload: Record<string, unknown>) {
    const r = await this.call<{ messages?: Array<{ id: string }> }>(`${creds.phoneNumberId}/messages`, creds.accessToken, {
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload },
    });
    const id = r.messages?.[0]?.id;
    if (!id) throw new WaError('Cloud API returned no message id');
    return { messageId: id };
  }

  sendMessage(creds: WaCreds, to: string, msg: OutboundMessage) {
    if (msg.kind === 'text') return this.send(creds, { to, type: 'text', text: { body: msg.body, preview_url: false } });
    if (msg.kind === 'buttons') {
      return this.send(creds, {
        to, type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: msg.body },
          action: { buttons: msg.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
        },
      });
    }
    return this.send(creds, {
      to, type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: msg.body },
        action: { button: msg.buttonLabel, sections: [{ title: '·', rows: msg.rows }] },
      },
    });
  }

  sendTemplate(creds: WaCreds, to: string, t: TemplateSend) {
    const components: unknown[] = [];
    if (t.bodyParams.length) components.push({ type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text })) });
    t.buttonPayloads.forEach((payload, index) =>
      components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] }),
    );
    (t.urlParams ?? []).forEach((suffix, i) =>
      components.push({ type: 'button', sub_type: 'url', index: String(t.buttonPayloads.length + i), parameters: [{ type: 'text', text: suffix }] }),
    );
    return this.send(creds, { to, type: 'template', template: { name: t.name, language: { code: t.language }, components } });
  }

  async createTemplate(creds: WaCreds, def: TemplateDef) {
    const components: unknown[] = [{ type: 'BODY', text: def.body, example: { body_text: [def.examples] } }];
    const buttons: unknown[] = [
      ...def.buttons.map((text) => ({ type: 'QUICK_REPLY', text })),
      // The link base is deployment config; Meta appends the per-message suffix ({{1}}) when we send.
      ...(def.urlButtons ?? []).map((text) => ({ type: 'URL', text, url: `${env.PUBLIC_API_URL}/api/receipts/{{1}}`, example: [`${env.PUBLIC_API_URL}/api/receipts/example-token`] })),
    ];
    if (buttons.length) components.push({ type: 'BUTTONS', buttons });
    const r = await this.call<{ id: string; status: string }>(`${creds.wabaId}/message_templates`, creds.accessToken, {
      body: { name: def.name, language: def.language, category: def.category, components },
    });
    return { id: r.id, status: r.status ?? 'PENDING' };
  }

  async listTemplates(creds: WaCreds): Promise<RemoteTemplate[]> {
    const r = await this.call<{ data: Array<{ id: string; name: string; language: string; status: string; rejected_reason?: string }> }>(
      `${creds.wabaId}/message_templates`, creds.accessToken, { query: { fields: 'id,name,language,status,rejected_reason', limit: '100' } },
    );
    return r.data.map((t) => ({ id: t.id, name: t.name, language: t.language, status: t.status, reason: t.rejected_reason }));
  }

  async subscribeApp(creds: WaCreds) {
    await this.call(`${creds.wabaId}/subscribed_apps`, creds.accessToken, { method: 'POST', body: {} });
  }

  async getPhoneInfo(creds: WaCreds) {
    const r = await this.call<{ display_phone_number?: string; verified_name?: string }>(creds.phoneNumberId, creds.accessToken, {
      query: { fields: 'display_phone_number,verified_name' },
    });
    return { displayPhone: r.display_phone_number ?? '', verifiedName: r.verified_name };
  }
}

/** Exchanges the Embedded Signup code for a business token (server-side; needs the app secret). */
export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw new WaError('META_APP_ID / META_APP_SECRET are not configured');
  const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', env.META_APP_ID);
  url.searchParams.set('client_secret', env.META_APP_SECRET);
  url.searchParams.set('code', code);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const json = (await res.json()) as { access_token?: string; error?: { message: string } };
  if (!res.ok || !json.access_token) throw new WaError(json.error?.message ?? 'Could not exchange the Embedded Signup code');
  return json.access_token;
}
