import { COUNTRY_CONFIG } from './countries';
type SurveyLang = 'en' | 'fr';

/**
 * Joining a survey from a link or a QR code (WA-05). The link is a plain WhatsApp link to the OWNER's own number with the words "JOIN <code>" already typed; the person
 * only has to press send. Nothing is hosted on SurveyFlow's side for the public, so there is no public page or form to attack, and the number that joins is proven by
 * WhatsApp itself (the message comes from it).
 *
 * The code is 16 random bytes in base32 (26 characters, 128 bits): not guessable, and a different one for every survey.
 */
export const JOIN_CODE_LENGTH = 26;
export const JOIN_CODE_RE = /^[a-z2-7]{26}$/;

/** "JOIN abc…", "join: abc…", "Join-abc…" with stray spaces or a trailing full stop: the code, lower-cased, or null when the message is not a join request. */
export function parseJoinMessage(body: string): string | null {
  const m = /^\s*(?:join|rejoindre)\s*[:\-–]?\s*([a-z2-7]{26})\s*[.!]?\s*$/i.exec(body);
  return m ? m[1]!.toLowerCase() : null;
}

/** The link an owner shares: opens WhatsApp on the owner's number with the join words typed. `waNumber` is the number in international form, any punctuation. */
export const joinLink = (waNumber: string, code: string): string => `https://wa.me/${waNumber.replace(/\D/g, '')}?text=${encodeURIComponent(`JOIN ${code}`)}`;

/** The supported country a number belongs to (longest calling code wins), or null for a country the product does not list. */
export function countryOfPhone(e164: string): string | null {
  const digits = e164.replace(/\D/g, '');
  let best: string | null = null;
  let bestLen = 0;
  for (const [iso, c] of Object.entries(COUNTRY_CONFIG)) {
    if (digits.startsWith(c.callingCode) && c.callingCode.length > bestLen) { best = iso; bestLen = c.callingCode.length; }
  }
  return best;
}

/** Does this number pass the owner's country list? An empty list means no limit. A number from a country the product does not list passes only when there is no list. */
export function countryAllowed(e164: string, allowed: readonly string[]): boolean {
  if (!allowed.length) return true;
  const c = countryOfPhone(e164);
  return c !== null && allowed.includes(c);
}

export interface JoinSettings {
  enabled: boolean;
  expiresAt: Date | null;
  max: number | null;
  countries: string[];
}

export type JoinRefusal = 'off' | 'expired' | 'full' | 'country' | 'closed';

/** Why a join would be refused right now (never shown to the person: they are only told the link is not valid), or null when it may go ahead. `joined` = people who joined so far. */
export function joinRefusal(s: JoinSettings, o: { surveyActive: boolean; joined: number; phone: string; now?: Date }): JoinRefusal | null {
  if (!s.enabled) return 'off';
  if (!o.surveyActive) return 'closed';
  if (s.expiresAt && s.expiresAt.getTime() <= (o.now ?? new Date()).getTime()) return 'expired';
  if (s.max !== null && o.joined >= s.max) return 'full';
  if (!countryAllowed(o.phone, s.countries)) return 'country';
  return null;
}

const T = {
  en: {
    consent: (business: string, title: string) =>
      `Hello! ${business} invites you to answer a short survey: “${title}”.\n\nIf you go ahead, ${business} will keep your answers and this WhatsApp number to read the results. You can stop at any time by replying STOP.\n\nReply START to begin.`,
    invalid: 'Sorry, this link is not valid any more.',
  },
  fr: {
    consent: (business: string, title: string) =>
      `Bonjour ! ${business} vous invite à répondre à un court sondage : « ${title} ».\n\nSi vous continuez, ${business} conservera vos réponses et ce numéro WhatsApp pour lire les résultats. Vous pouvez arrêter à tout moment en répondant STOP.\n\nRépondez START pour commencer.`,
    invalid: 'Désolé, ce lien n’est plus valide.',
  },
} as const;

/** The first message to somebody who joined: who is asking, what is kept, how to stop, and what to type. */
export const joinConsentText = (lang: SurveyLang, business: string, title: string): string => T[lang].consent(business, title);
export const joinInvalidText = (lang: SurveyLang): string => T[lang].invalid;
