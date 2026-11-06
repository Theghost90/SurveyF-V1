import { afterEach, describe, expect, it, vi } from 'vitest';
import { sys } from '@surveyflow/shared';
import { CloudApiGateway } from '../src/services/whatsapp/cloud';

afterEach(() => vi.unstubAllGlobals());

describe('a message with a link button', () => {
  it('goes to Meta as an interactive cta_url (a real button with the link behind it), not as text with a URL in it', async () => {
    const f = vi.fn(async (_url: unknown, _init?: { body?: string }) => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.X' }] }) }) as Response);
    vi.stubGlobal('fetch', f);
    const url = 'https://api.example.com/api/receipts/abc.def';
    await new CloudApiGateway().sendMessage({ phoneNumberId: 'p1', accessToken: 't' } as never, '237677000001', { kind: 'link', body: 'Your gift has been sent.', buttonLabel: 'Download receipt', url });
    const body = JSON.parse(f.mock.calls[0]![1]!.body!);
    expect(body).toMatchObject({
      messaging_product: 'whatsapp', to: '237677000001', type: 'interactive',
      interactive: { type: 'cta_url', body: { text: 'Your gift has been sent.' }, action: { name: 'cta_url', parameters: { display_text: 'Download receipt', url } } },
    });
    expect(JSON.stringify(body.interactive.body)).not.toContain('/api/receipts/');
  });

  it('the receipt button label fits WhatsApp\'s 20-character limit in both languages', () => {
    for (const lang of ['en', 'fr'] as const) expect(sys(lang).receiptButton.length, lang).toBeLessThanOrEqual(20);
  });
});
