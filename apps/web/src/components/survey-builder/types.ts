import { WA_LIMITS, endOfLocalDay, localDateString, type GiftType, type QuestionType, type SurveyKind, type SurveyLang } from '@surveyflow/shared';
import { money } from '@/lib/format';
import type { TFn } from '@/lib/i18n';

export interface OptionDraft { id: string; label: string }
export interface QuestionDraft { key: string; text: string; type: QuestionType; options: OptionDraft[]; required: boolean }
export interface GiftDraft { giftType: GiftType; giftValue: string; giftAmount: string; giftDeliveryMode: 'immediate' | 'batch'; giftMaxCount: string }
export interface SurveyDraft {
  title: string;
  description: string;
  language: SurveyLang;
  customThankYou: string;
  /** 'event' = a live event now or within days: faster reminder rule, and it needs a deadline. */
  kind: SurveyKind;
  /** Last day to answer, as a local calendar date (YYYY-MM-DD) in the owner's time zone; '' = none. Stored as the END of that day. */
  deadline: string;
  /** The people get this because of something they did with the business: what lets the invitation be a utility message (WA-03). */
  followsTransaction: boolean;
  autoRemindNonResponders: boolean;
  autoRemindAbandoners: boolean;
  gift: GiftDraft;
  questions: QuestionDraft[];
}

const rand = () => Math.random().toString(36).slice(2, 8);
export const newKey = () => `k${rand()}${rand()}`;
export const newOption = (label = ''): OptionDraft => ({ id: `o${rand()}${rand()}`, label });
export const newQuestion = (type: QuestionType = 'button'): QuestionDraft => ({
  key: newKey(), text: '', type, required: true,
  options: type === 'button' || type === 'list' || type === 'multi' ? [newOption(), newOption()] : [],
});

export const optionLimit = (type: QuestionType) => (type === 'button' ? WA_LIMITS.maxButtons : type === 'list' || type === 'multi' ? WA_LIMITS.maxListRows : 0);
export const labelLimit = (type: QuestionType) => (type === 'button' ? WA_LIMITS.buttonTitle : type === 'list' ? WA_LIMITS.rowTitle : WA_LIMITS.multiLabel);

export function fromApi(s: any, offsetMin: number): SurveyDraft {
  return {
    title: s.title ?? '',
    description: s.description ?? '',
    language: s.language === 'en' ? 'en' : 'fr',
    customThankYou: s.customThankYou ?? '',
    kind: s.kind === 'event' ? 'event' : 'general',
    deadline: s.deadlineAt ? localDateString(new Date(s.deadlineAt), offsetMin) : '',
    followsTransaction: !!s.followsTransaction,
    autoRemindNonResponders: !!s.autoRemindNonResponders,
    autoRemindAbandoners: !!s.autoRemindAbandoners,
    gift: {
      giftType: s.giftType ?? 'none', giftValue: s.giftValue ?? '', giftAmount: s.giftAmount ? String(s.giftAmount) : '',
      giftDeliveryMode: s.giftDeliveryMode ?? 'immediate', giftMaxCount: s.giftMaxCount ? String(s.giftMaxCount) : '',
    },
    questions: (s.questions ?? []).map((q: any) => ({
      key: q.id ?? newKey(), text: q.text, type: q.type, required: q.required,
      options: q.type === 'rating' ? [] : ((q.options as OptionDraft[] | null) ?? []).map((o) => ({ id: o.id, label: o.label })),
    })),
  };
}

export function toPayload(d: SurveyDraft, offsetMin: number) {
  const g = d.gift;
  return {
    title: d.title.trim(),
    description: d.description.trim() || null,
    language: d.language,
    customThankYou: d.customThankYou.trim() || null,
    kind: d.kind,
    deadlineAt: d.deadline ? (endOfLocalDay(d.deadline, offsetMin)?.toISOString() ?? null) : null,
    followsTransaction: d.followsTransaction,
    autoRemindNonResponders: d.autoRemindNonResponders,
    autoRemindAbandoners: d.autoRemindAbandoners,
    gift: {
      giftType: g.giftType,
      giftValue: g.giftValue.trim() || null,
      giftAmount: g.giftAmount ? Number(g.giftAmount) : null,
      giftDeliveryMode: g.giftDeliveryMode,
      giftMaxCount: g.giftMaxCount ? Number(g.giftMaxCount) : null,
    },
    questions: d.questions.map((q) => ({
      text: q.text.trim(), type: q.type, required: q.required,
      options: q.type === 'text' || q.type === 'rating' ? null : q.options.map((o) => ({ id: o.id, label: o.label.trim() })),
    })),
  };
}

export interface QuestionErrors { text?: string; options?: string; labels: Record<number, string> }
export interface DraftErrors { title?: string; deadline?: string; gift: Partial<Record<'giftValue' | 'giftAmount' | 'giftMaxCount', string>>; questions: Record<string, QuestionErrors>; count: number }

/** Client-side validation with localized messages; numbers come from the same WA_LIMITS the server enforces. */
/**
 * `giftLimits`/`currency` are the owner's wallet limits (100–20,000 FCFA converted to their currency); unknown while the exchange rate is
 * unavailable, in which case only the server checks the range.
 */
export function validateDraft(d: SurveyDraft, t: TFn, today: string, giftLimits: { giftMin: number; giftMax: number } | null = null, currency = 'XAF'): DraftErrors {
  const errors: DraftErrors = { gift: {}, questions: {}, count: 0 };
  if (!d.title.trim()) { errors.title = t('b.err.title'); errors.count++; }
  if (d.kind === 'event' && !d.deadline) { errors.deadline = t('b.err.deadline'); errors.count++; }
  else if (d.deadline && d.deadline < today) { errors.deadline = t('b.err.deadlinePast'); errors.count++; }
  for (const q of d.questions) {
    const e: QuestionErrors = { labels: {} };
    if (!q.text.trim()) e.text = t('b.err.text');
    else if (q.text.length > WA_LIMITS.questionText) e.text = t('b.err.textLong', { n: WA_LIMITS.questionText });
    if (q.type === 'button' || q.type === 'list' || q.type === 'multi') {
      const max = optionLimit(q.type);
      const labels = q.options.map((o) => o.label.trim().toLowerCase());
      if (q.options.length < 2) e.options = t('b.err.optionsMin');
      else if (q.options.length > max) e.options = q.type === 'button' ? t('b.err.buttonsMax', { n: max }) : t('b.err.listMax', { n: max });
      else if (new Set(labels).size !== labels.length) e.options = t('b.err.optionsUnique');
      q.options.forEach((o, i) => {
        if (!o.label.trim()) e.labels[i] = t('b.err.optionEmpty');
        else if (o.label.length > labelLimit(q.type)) e.labels[i] = t('b.err.optionLong', { n: labelLimit(q.type) });
      });
    }
    if (e.text || e.options || Object.keys(e.labels).length) {
      errors.questions[q.key] = e;
      errors.count++;
    }
  }
  const g = d.gift;
  if (g.giftType === 'airtime' || g.giftType === 'momo') {
    const n = Number(g.giftAmount);
    const lo = giftLimits?.giftMin ?? 1;
    const hi = giftLimits?.giftMax ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(n) || n < lo || n > hi) { errors.gift.giftAmount = giftLimits ? t('b.err.amount', { min: money(giftLimits.giftMin, currency, 'en'), max: money(giftLimits.giftMax, currency, 'en') }) : t('b.err.amountPlain'); errors.count++; }
  }
  if (['airtime', 'momo', 'discount', 'prize_draw'].includes(g.giftType) && !g.giftValue.trim()) { errors.gift.giftValue = t('b.err.giftValue'); errors.count++; }
  if (g.giftMaxCount && (!Number.isInteger(Number(g.giftMaxCount)) || Number(g.giftMaxCount) < 1)) { errors.gift.giftMaxCount = t('b.err.giftMax'); errors.count++; }
  return errors;
}
