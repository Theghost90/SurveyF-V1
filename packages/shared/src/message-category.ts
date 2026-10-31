/**
 * Which WhatsApp category a survey's invitation is sent under (WA-03). Meta bills a business-initiated template message by its category (marketing costs more than
 * utility) and treats a promotion sent as "utility" as a policy problem: the account's quality rating and the template's approval are what is at risk.
 * Meta's own documentation names a feedback survey with promotional content as a mixed-content risk; other sources say a feedback request is utility only when it is
 * tied to a specific order or interaction. Meta decides in the end (it re-categorises templates, also after approval), so this is a DEFAULT, not a verdict:
 *
 *   marketing   whenever there is any doubt. This is the safe direction: it costs more, it breaks no rule.
 *   utility     only when ALL of these hold: the owner says the survey follows something the person did with the business (a purchase, a booking, a visit),
 *               no reward or prize is attached, and nothing in the survey's own text reads as a promotion.
 *
 * The owner cannot force utility: the reasons are shown instead, so that the wording can be changed (or the cost accepted). Pure functions, shared by the
 * website (instant feedback while writing) and the API (which decides, at the moment of sending).
 */
export type MessageCategory = 'utility' | 'marketing';

export type CategoryReason =
  | { code: 'not_a_follow_up' }
  | { code: 'gift' }
  | { code: 'promo_wording'; terms: string[] }
  | { code: 'meta_recategorised' }
  | { code: 'meta_will_recategorise'; at: string | null };

/** Words and phrases that read as a promotion, in English and French. Matched as whole words after lower-casing and removing accents. A match makes it marketing: a false alarm costs a higher fee, a miss costs a policy problem. */
export const PROMO_TERMS = [
  // English
  'discount', 'percent off', 'sale', 'promo', 'promotion', 'promotional', 'offer', 'special offer', 'coupon', 'voucher', 'deal', 'free', 'win', 'prize', 'gift', 'giveaway',
  'bonus', 'limited time', 'buy', 'buy now', 'shop now', 'order now', 'exclusive', 'cashback', 'lottery', 'raffle', 'draw',
  // French
  'remise', 'reduction', 'soldes', 'promotion', 'offre', 'offre speciale', 'bon d achat', 'bon de reduction', 'code promo', 'gratuit', 'gratuite', 'gratuitement', 'gagnez',
  'gagner', 'cadeau', 'cadeaux', 'concours', 'tirage', 'tirage au sort', 'duree limitee', 'achetez', 'commandez', 'exclusif', 'exclusive', 'loterie',
] as const;

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
const FOLDED = [...new Set(PROMO_TERMS)].map((t) => ({ term: t, folded: ` ${fold(t)} ` }));

/** The promotional terms found in a text (at most `max`), in the form listed in PROMO_TERMS. A percentage followed by off, discount or remise counts too. */
export function findPromoTerms(text: string | null | undefined, max = 5): string[] {
  if (!text) return [];
  const padded = ` ${fold(text)} `;
  const found: string[] = [];
  for (const { term, folded } of FOLDED) if (padded.includes(folded) && !found.includes(term)) found.push(term);
  // "20% off", "30 % de remise": a percentage on its own ("rate from 0 to 100%") is not a promotion
  if (/\d\s?%\s?(off|discount|de remise|de reduction|remise|reduction|rabais)/.test(fold(text)) && !found.includes('%')) found.push('% off');
  return found.slice(0, max);
}

export interface CategoryInput {
  title: string;
  description?: string | null;
  customThankYou?: string | null;
  /** The owner's statement: the people get this because of something they did with the business (a purchase, a booking, a visit). */
  followsTransaction?: boolean | null;
  giftType?: string | null;
  questions?: Array<{ text: string; options?: Array<{ label?: string }> | null }>;
}

/** The category the survey's own content points to, and why not utility when it is marketing. Says nothing about what Meta has done to the template: see `withTemplateState`. */
export function classifySurvey(s: CategoryInput): { category: MessageCategory; reasons: CategoryReason[] } {
  const reasons: CategoryReason[] = [];
  if (!s.followsTransaction) reasons.push({ code: 'not_a_follow_up' });
  if (s.giftType && s.giftType !== 'none') reasons.push({ code: 'gift' });
  const texts = [s.title, s.description, s.customThankYou, ...(s.questions ?? []).flatMap((q) => [q.text, ...(q.options ?? []).map((o) => o.label)])];
  const terms: string[] = [];
  for (const text of texts) for (const t of findPromoTerms(text)) if (!terms.includes(t)) terms.push(t);
  if (terms.length) reasons.push({ code: 'promo_wording', terms: terms.slice(0, 5) });
  return { category: reasons.length ? 'marketing' : 'utility', reasons };
}

/** What Meta has done to the utility invitation template of this WhatsApp account, as stored from its notices. */
export interface TemplateState { category: string; pendingCategory?: string | null; pendingAt?: Date | string | null }

/**
 * The category the invitation will really be billed under: marketing when the content says so, and ALSO when Meta has moved the utility invitation template to
 * marketing (every survey then costs the marketing rate, whatever it says). A change Meta has announced but not made yet is a warning, not yet a category.
 */
export function withTemplateState(base: { category: MessageCategory; reasons: CategoryReason[] }, utilityTemplate: TemplateState | null | undefined): { category: MessageCategory; reasons: CategoryReason[] } {
  if (base.category !== 'utility' || !utilityTemplate) return base;
  if (utilityTemplate.category.toUpperCase() === 'MARKETING') return { category: 'marketing', reasons: [...base.reasons, { code: 'meta_recategorised' }] };
  if (utilityTemplate.pendingCategory?.toUpperCase() === 'MARKETING') {
    const at = utilityTemplate.pendingAt ? new Date(utilityTemplate.pendingAt).toISOString() : null;
    return { category: 'utility', reasons: [{ code: 'meta_will_recategorise', at }] };
  }
  return base;
}
