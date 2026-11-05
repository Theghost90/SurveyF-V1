/**
 * Embedded Signup and WhatsApp Business app coexistence: the pure parts (no network, no database), shared by the API and the web app.
 *
 * Written from Meta's pages as fetched on 2026-11-05 (Embedded Signup v4, v5, "Onboard WhatsApp Business app users"). NOT yet exercised against a real
 * Meta app: the shapes below are Meta's documented ones, and docs/META_CHECK.md lists the real-number checks that still have to be run.
 */

/** v2 and v3 are deprecated by Meta on 15 October 2026 and a launch with no version is served as v4 (coexistence OFF). v5 has Business-app onboarding ON by default. */
export const SIGNUP_VERSION = 'v5';

/** What the owner tells us before the Connect button. Only used to explain and to warn: Meta decides the flow, and `is_on_biz_app` after Finish is the truth (D-19). */
export const NUMBER_SITUATIONS = ['new', 'business_app', 'personal_app'] as const;
export type NumberSituation = (typeof NUMBER_SITUATIONS)[number];

/** `cloud`: the number lives on the Cloud API only (Armand). `coexistence`: the number is in the WhatsApp Business app AND the Cloud API (Mireille). */
export type AccountMode = 'cloud' | 'coexistence';

/** The options handed to `FB.login`. Always opts in to coexistence (v5 default); `setup` is required by Meta. */
export function signupLaunchOptions(configId: string) {
  return {
    config_id: configId,
    response_type: 'code' as const,
    override_default_response_type: true,
    extras: { setup: {}, version: SIGNUP_VERSION },
  };
}

export interface SignupSession {
  /** The Messaging account (v5 `messaging_account_ids[0]`, v3/v4 `waba_id`). */
  wabaId: string;
  /** Absent in the v3/v4 coexistence event, which carries only the Messaging account: the server then looks the number up. */
  phoneNumberId: string | null;
  /** What Meta says in the browser. The server never trusts it: it reads `is_on_biz_app` from the Graph API itself. */
  isOnBizApp: boolean | null;
  businessId: string | null;
}

export type SignupEvent =
  | { kind: 'finish'; session: SignupSession; event: string }
  | { kind: 'cancel'; step: string | null }
  | { kind: 'error'; message: string | null; errorId: string | null };

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null);

/**
 * Reads one `message` event from Meta's popup. Accepts a JSON string or an object, ignores everything that is not `WA_EMBEDDED_SIGNUP`, and understands the
 * v5 object as well as the v3/v4 ones, because a deployment may be served an older one while the Facebook Login for Business configuration is being changed.
 */
export function parseSignupEvent(raw: unknown): SignupEvent | null {
  let d: any = raw;
  if (typeof raw === 'string') {
    try { d = JSON.parse(raw); } catch { return null; }
  }
  if (!d || typeof d !== 'object' || d.type !== 'WA_EMBEDDED_SIGNUP') return null;
  const event = String(d.event ?? '');
  const data = d.data && typeof d.data === 'object' ? d.data : {};
  if (event === 'CANCEL') return { kind: 'cancel', step: str(data.current_step) };
  if (event === 'ERROR') return { kind: 'error', message: str(data.error_message), errorId: str(data.error_id) };
  if (event !== 'FINISH' && event !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') return null;
  const wabaId = Array.isArray(data.messaging_account_ids) ? str(data.messaging_account_ids[0]) : str(data.waba_id);
  if (!wabaId) return null;
  const onApp = typeof data.is_on_biz_app === 'boolean' ? data.is_on_biz_app : event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' ? true : null;
  return { kind: 'finish', event, session: { wabaId, phoneNumberId: str(data.phone_number_id), isOnBizApp: onApp, businessId: str(data.business_id) } };
}

/** What to tell the owner when the situation they declared and the one Meta reports do not agree. */
export function situationCheck(declared: NumberSituation | null | undefined, isOnBizApp: boolean | null): 'ok' | 'said_new_but_in_app' | 'said_app_but_not' | 'unknown' {
  if (isOnBizApp === null || !declared) return 'unknown';
  if (declared === 'new' && isOnBizApp) return 'said_new_but_in_app';
  if (declared === 'business_app' && !isOnBizApp) return 'said_app_but_not';
  return 'ok';
}

export const modeOf = (isOnBizApp: boolean): AccountMode => (isOnBizApp ? 'coexistence' : 'cloud');

// ---- webhooks that only exist for coexistence ---------------------------------------------------------------------------------------------------------------

/** Meta's `PARTNER_REMOVED` reasons (account_update.disconnection_info.reason). */
export const DISCONNECT_REASONS = ['ACCOUNT_DISCONNECTED', 'BUSINESS_DOWNGRADE', 'CHANGE_NUMBER', 'COMPANION_INACTIVITY', 'PRIMARY_INACTIVITY', 'USER_RE_REGISTERED'] as const;
export type DisconnectReason = (typeof DISCONNECT_REASONS)[number] | 'OTHER';

export type CoexistenceEvent =
  | { kind: 'partner_removed'; wabaId: string; reason: DisconnectReason; initiatedBy: 'USER' | 'SYSTEM' | null }
  | { kind: 'offboarded'; wabaId: string }
  | { kind: 'reconnected'; wabaId: string }
  | { kind: 'contacts'; wabaId: string; phoneNumberId: string; contacts: Array<{ phone: string; name: string; action: 'add' | 'edit' | 'remove' }> }
  | { kind: 'history'; wabaId: string; phoneNumberId: string; phase: number | null; progress: number | null; threads: number; declined: boolean }
  | { kind: 'echo'; wabaId: string; phoneNumberId: string; count: number };

/** Meta: a `history` webhook with this error code means the owner declined to share the chat history. */
export const HISTORY_DECLINED_CODE = 2593109;

/**
 * Picks the coexistence events out of a webhook body. Message CONTENTS are never read: an echo is counted, a history thread is counted, and what the owner wrote
 * to their customers stays in their WhatsApp app (data minimisation, D-19). Contacts are names and numbers only.
 */
export function parseCoexistenceEvents(body: unknown): CoexistenceEvent[] {
  const out: CoexistenceEvent[] = [];
  const entries = (body as { entry?: Array<{ id?: unknown; changes?: Array<{ field?: string; value?: any }> }> })?.entry ?? [];
  for (const entry of entries) {
    for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      if (ch.field === 'account_update') {
        const ev = String(v.event ?? '');
        const wabaId = str(v.waba_info?.waba_id) ?? str(entry.id);
        if (!wabaId) continue;
        if (ev === 'PARTNER_REMOVED') {
          const r = String(v.disconnection_info?.reason ?? '');
          const by = String(v.disconnection_info?.initiated_by ?? '');
          out.push({ kind: 'partner_removed', wabaId, reason: (DISCONNECT_REASONS as readonly string[]).includes(r) ? (r as DisconnectReason) : 'OTHER', initiatedBy: by === 'USER' || by === 'SYSTEM' ? by : null });
        } else if (ev === 'ACCOUNT_OFFBOARDED') out.push({ kind: 'offboarded', wabaId });
        else if (ev === 'ACCOUNT_RECONNECTED') out.push({ kind: 'reconnected', wabaId });
        continue;
      }
      const wabaId = str(entry.id);
      const phoneNumberId = str(v.metadata?.phone_number_id);
      if (!wabaId || !phoneNumberId) continue;
      if (ch.field === 'smb_app_state_sync') {
        const contacts: Array<{ phone: string; name: string; action: 'add' | 'edit' | 'remove' }> = [];
        for (const s of (v.state_sync ?? []) as Array<{ type?: string; contact?: { full_name?: string; first_name?: string; phone_number?: string }; action?: string }>) {
          if (s.type !== 'contact' || !s.contact?.phone_number) continue;
          const action = s.action === 'remove' ? 'remove' : s.action === 'edit' ? 'edit' : 'add';
          contacts.push({ phone: String(s.contact.phone_number), name: String(s.contact.full_name ?? s.contact.first_name ?? '').slice(0, 120), action });
        }
        out.push({ kind: 'contacts', wabaId, phoneNumberId, contacts });
      } else if (ch.field === 'history') {
        for (const h of (v.history ?? []) as Array<{ metadata?: { phase?: number; progress?: number }; threads?: unknown[]; errors?: Array<{ code?: number }> }>) {
          const declined = (h.errors ?? []).some((e) => Number(e.code) === HISTORY_DECLINED_CODE) || (v.errors ?? []).some((e: { code?: number }) => Number(e.code) === HISTORY_DECLINED_CODE);
          out.push({ kind: 'history', wabaId, phoneNumberId, phase: typeof h.metadata?.phase === 'number' ? h.metadata.phase : null, progress: typeof h.metadata?.progress === 'number' ? h.metadata.progress : null, threads: Array.isArray(h.threads) ? h.threads.length : 0, declined });
        }
      } else if (ch.field === 'smb_message_echoes') {
        out.push({ kind: 'echo', wabaId, phoneNumberId, count: Array.isArray(v.message_echoes) ? v.message_echoes.length : 0 });
      }
    }
  }
  return out;
}

// ---- the owner's share kit (WA-14) -------------------------------------------------------------------------------------------------------------------------

/**
 * The text an owner pastes into a WhatsApp chat or status to hand out a survey: a line, the link, nothing else. The link opens a chat with the owner's own
 * connected number with the join words typed in (WA-05). Never contains a participant's name or number.
 */
export function shareMessage(lang: 'fr' | 'en', title: string, link: string): string {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 80);
  return lang === 'fr'
    ? `Votre avis compte : ${t}. Répondez ici en quelques minutes, directement sur WhatsApp : ${link}`
    : `Your opinion counts: ${t}. Answer in a few minutes, right here on WhatsApp: ${link}`;
}

/** Opens WhatsApp's own "send to…" picker with the message filled in (works from a phone and from WhatsApp Web). */
export const shareDeepLink = (message: string): string => `https://wa.me/?text=${encodeURIComponent(message)}`;

// ---- why a number was disconnected, in our own words (never Meta's raw text) ------------------------------------------------------------------------------

/** One short cause and one fix per Meta reason. Used by the e-mail and by the banner in Settings, so both say the same thing. */
export function disconnectExplanation(reason: string | null | undefined, initiatedBy: string | null | undefined, lang: 'fr' | 'en'): { why: string; fix: string } {
  const fr = lang === 'fr';
  const fix = fr ? 'Reconnectez le numéro dans SurveyFlow (Réglages, WhatsApp). Vos sondages et vos réponses n’ont pas été touchés.' : 'Reconnect the number in SurveyFlow (Settings, WhatsApp). Your surveys and answers are untouched.';
  const why: Record<string, [string, string]> = {
    PRIMARY_INACTIVITY: ['L’application WhatsApp Business de votre téléphone n’a pas été ouverte depuis environ 14 jours.', 'The WhatsApp Business app on your phone has not been opened for about 14 days.'],
    COMPANION_INACTIVITY: ['Un appareil lié à votre compte est resté inactif pendant environ 30 jours.', 'A device linked to your account stayed inactive for about 30 days.'],
    USER_RE_REGISTERED: ['Votre numéro a été réinstallé sur un autre appareil.', 'Your number was set up again on another device.'],
    CHANGE_NUMBER: ['Le numéro du compte WhatsApp a été changé.', 'The number of the WhatsApp account was changed.'],
    BUSINESS_DOWNGRADE: ['Le numéro a été enregistré dans l’application WhatsApp grand public.', 'The number was registered in the ordinary WhatsApp app.'],
    ACCOUNT_DISCONNECTED: [initiatedBy === 'USER' ? 'Le compte a été déconnecté depuis l’application WhatsApp Business (Réglages, Compte, Plateforme Business).' : 'Le compte WhatsApp a été déconnecté (suppression du compte ou décision de WhatsApp).', initiatedBy === 'USER' ? 'The account was disconnected from the WhatsApp Business app (Settings, Account, Business Platform).' : 'The WhatsApp account was disconnected (account deleted, or a decision by WhatsApp).'],
    OFFBOARDED: ['Le numéro a changé d’appareil ou a été réinscrit, ce qui coupe la liaison.', 'The number moved device or was registered again, which cuts the link.'],
  };
  const pair = why[reason ?? ''] ?? ['WhatsApp a coupé la liaison avec SurveyFlow.', 'WhatsApp cut the link with SurveyFlow.'];
  return { why: fr ? pair[0] : pair[1], fix };
}
