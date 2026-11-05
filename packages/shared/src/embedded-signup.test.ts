import { describe, expect, it } from 'vitest';
import { modeOf, parseCoexistenceEvents, parseSignupEvent, shareDeepLink, shareMessage, signupLaunchOptions, situationCheck } from './embedded-signup';

describe('launch options', () => {
  it('names v5 explicitly, so the launch is not served as v4 with coexistence off', () => {
    const o = signupLaunchOptions('cfg1');
    expect(o.extras.version).toBe('v5');
    expect(o.config_id).toBe('cfg1');
    expect(o.response_type).toBe('code');
    expect(o.extras.setup).toEqual({});
  });
});

describe('Embedded Signup session events', () => {
  const v5 = (over: object = {}, event = 'FINISH') => ({ type: 'WA_EMBEDDED_SIGNUP', event, data: { phone_number_id: 'pn1', is_on_biz_app: false, messaging_account_ids: ['wa1'], primary_waac_ids: [], business_id: 'biz1', ...over } });

  it('reads the v5 object (Armand: a new number)', () => {
    const e = parseSignupEvent(JSON.stringify(v5()));
    expect(e).toEqual({ kind: 'finish', event: 'FINISH', session: { wabaId: 'wa1', phoneNumberId: 'pn1', isOnBizApp: false, businessId: 'biz1' } });
  });
  it('reads the v5 object (Mireille: a WhatsApp Business app number)', () => {
    const e = parseSignupEvent(v5({ is_on_biz_app: true }, 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'));
    expect(e).toMatchObject({ kind: 'finish', session: { wabaId: 'wa1', isOnBizApp: true } });
  });
  it('still reads the v3/v4 shapes, the coexistence one carrying only the Messaging account', () => {
    expect(parseSignupEvent({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 'w9', phone_number_id: 'p9' } })).toMatchObject({ session: { wabaId: 'w9', phoneNumberId: 'p9', isOnBizApp: null } });
    expect(parseSignupEvent({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: 'w9' } })).toMatchObject({ session: { wabaId: 'w9', phoneNumberId: null, isOnBizApp: true } });
  });
  it('reads a cancel and an error, and ignores everything else', () => {
    expect(parseSignupEvent({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'QR' } })).toEqual({ kind: 'cancel', step: 'QR' });
    expect(parseSignupEvent({ type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: { error_message: 'x', error_id: '7' } })).toEqual({ kind: 'error', message: 'x', errorId: '7' });
    expect(parseSignupEvent('not json')).toBeNull();
    expect(parseSignupEvent({ type: 'OTHER' })).toBeNull();
    expect(parseSignupEvent({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: {} })).toBeNull(); // no account id: nothing to onboard
    expect(parseSignupEvent({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_ONLY_WABA', data: { waba_id: 'x' } })).toBeNull();
  });
});

describe('what the owner said against what Meta says', () => {
  it('flags both disagreements and trusts Meta', () => {
    expect(situationCheck('new', true)).toBe('said_new_but_in_app');
    expect(situationCheck('business_app', false)).toBe('said_app_but_not');
    expect(situationCheck('new', false)).toBe('ok');
    expect(situationCheck('business_app', true)).toBe('ok');
    expect(situationCheck('personal_app', false)).toBe('ok');
    expect(situationCheck(null, true)).toBe('unknown');
    expect(situationCheck('new', null)).toBe('unknown');
    expect(modeOf(true)).toBe('coexistence');
    expect(modeOf(false)).toBe('cloud');
  });
});

describe('coexistence webhooks', () => {
  const wrap = (field: string, value: object, id = 'wa1') => ({ object: 'whatsapp_business_account', entry: [{ id, changes: [{ field, value }] }] });
  const meta = { messaging_product: 'whatsapp', metadata: { display_phone_number: '237600000001', phone_number_id: 'pn1' } };

  it('reads a disconnection with its reason, from the waba_info (entry.id is the partner there)', () => {
    const ev = parseCoexistenceEvents(wrap('account_update', { event: 'PARTNER_REMOVED', waba_info: { waba_id: 'wa1', owner_business_id: 'b' }, disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' } }, 'partner-biz'));
    expect(ev).toEqual([{ kind: 'partner_removed', wabaId: 'wa1', reason: 'PRIMARY_INACTIVITY', initiatedBy: 'SYSTEM' }]);
  });
  it('keeps an unknown reason as OTHER instead of dropping the disconnection', () => {
    const ev = parseCoexistenceEvents(wrap('account_update', { event: 'PARTNER_REMOVED', waba_info: { waba_id: 'wa1' }, disconnection_info: { reason: 'SOMETHING_NEW' } }));
    expect(ev[0]).toMatchObject({ kind: 'partner_removed', reason: 'OTHER', initiatedBy: null });
  });
  it('reads offboarded and reconnected (entry.id is the Messaging account)', () => {
    expect(parseCoexistenceEvents(wrap('account_update', { event: 'ACCOUNT_OFFBOARDED' }))).toEqual([{ kind: 'offboarded', wabaId: 'wa1' }]);
    expect(parseCoexistenceEvents(wrap('account_update', { event: 'ACCOUNT_RECONNECTED' }))).toEqual([{ kind: 'reconnected', wabaId: 'wa1' }]);
  });
  it('reads contacts: names and numbers only, with the action', () => {
    const ev = parseCoexistenceEvents(wrap('smb_app_state_sync', { ...meta, state_sync: [
      { type: 'contact', contact: { full_name: 'Pablo Morales', first_name: 'Pablo', phone_number: '16505551234' }, action: 'add', metadata: { timestamp: '1' } },
      { type: 'contact', contact: { phone_number: '16505559999' }, action: 'remove' },
      { type: 'other', contact: { phone_number: '1' } },
    ] }));
    expect(ev).toEqual([{ kind: 'contacts', wabaId: 'wa1', phoneNumberId: 'pn1', contacts: [{ phone: '16505551234', name: 'Pablo Morales', action: 'add' }, { phone: '16505559999', name: '', action: 'remove' }] }]);
  });
  it('counts history threads and reads no message text; a refusal to share shows as declined', () => {
    const ok = parseCoexistenceEvents(wrap('history', { ...meta, history: [{ metadata: { phase: 0, chunk_order: 1, progress: 55 }, threads: [{ id: '1', messages: [{ type: 'text', text: { body: 'SECRET' } }] }, { id: '2', messages: [] }] }] }));
    expect(ok).toEqual([{ kind: 'history', wabaId: 'wa1', phoneNumberId: 'pn1', phase: 0, progress: 55, threads: 2, declined: false }]);
    expect(JSON.stringify(ok)).not.toContain('SECRET');
    const no = parseCoexistenceEvents(wrap('history', { ...meta, history: [{ errors: [{ code: 2593109 }] }] }));
    expect(no[0]).toMatchObject({ kind: 'history', declined: true, threads: 0 });
  });
  it('counts echoes and reads no text', () => {
    const ev = parseCoexistenceEvents(wrap('smb_message_echoes', { ...meta, message_echoes: [{ from: '1', to: '2', id: 'w', type: 'text', text: { body: 'SECRET' } }] }));
    expect(ev).toEqual([{ kind: 'echo', wabaId: 'wa1', phoneNumberId: 'pn1', count: 1 }]);
  });
  it('ignores ordinary message webhooks and junk', () => {
    expect(parseCoexistenceEvents(wrap('messages', { ...meta, messages: [] }))).toEqual([]);
    expect(parseCoexistenceEvents(null)).toEqual([]);
    expect(parseCoexistenceEvents({ entry: [{ changes: [{ field: 'history', value: {} }] }] })).toEqual([]);
  });
});

describe('share kit', () => {
  it('is a line and a link, in the owner’s language, with no participant data', () => {
    const l = 'https://wa.me/237600000001?text=JOIN%20abc';
    expect(shareMessage('fr', ' Avis  clients ', l)).toBe(`Votre avis compte : Avis clients. Répondez ici en quelques minutes, directement sur WhatsApp : ${l}`);
    expect(shareMessage('en', 'Customer feedback', l)).toContain(l);
    expect(shareDeepLink('a b&c')).toBe('https://wa.me/?text=a%20b%26c');
  });
});
