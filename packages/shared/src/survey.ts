import { z } from 'zod';

export const QUESTION_TYPES = ['button', 'list', 'text', 'rating', 'multi'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const GIFT_TYPES = ['none', 'airtime', 'momo', 'discount', 'prize_draw', 'custom'] as const;
export type GiftType = (typeof GIFT_TYPES)[number];
export const SURVEY_LANGS = ['fr', 'en'] as const;
export type SurveyLang = (typeof SURVEY_LANGS)[number];

/** Hard limits of the WhatsApp Cloud API interactive messages. */
export const WA_LIMITS = {
  maxButtons: 3,
  buttonTitle: 20,
  maxListRows: 10,
  rowTitle: 24,
  listButtonLabel: 20,
  interactiveBody: 1024,
  textBody: 4096,
  /** Our own cap so "Question 3 of 5\n\n" + text always fits the interactive body. */
  questionText: 900,
  multiLabel: 60,
  maxQuestions: 25,
} as const;

export const RATING_SCALE = [1, 2, 3, 4, 5] as const;

export const optionSchema = z.object({
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, 'option id must be URL-safe'),
  label: z.string().trim().min(1),
});
export type QuestionOption = z.infer<typeof optionSchema>;

export const ratingOptions = (): QuestionOption[] => RATING_SCALE.map((n) => ({ id: String(n), label: String(n) }));

export const questionInputSchema = z
  .object({
    text: z.string().trim().min(1, 'Question text is required').max(WA_LIMITS.questionText),
    type: z.enum(QUESTION_TYPES),
    options: z.array(optionSchema).nullish(),
    required: z.boolean().default(true),
  })
  .superRefine((q, ctx) => {
    const issue = (message: string, path: (string | number)[] = ['options']) => ctx.addIssue({ code: 'custom', message, path });
    const opts = q.options ?? [];
    if (q.type === 'text') {
      if (opts.length) issue('Open-text questions cannot have options');
      return;
    }
    if (q.type === 'rating') return; // options are generated (1..5)
    const max = q.type === 'button' ? WA_LIMITS.maxButtons : WA_LIMITS.maxListRows;
    const maxLabel = q.type === 'button' ? WA_LIMITS.buttonTitle : q.type === 'list' ? WA_LIMITS.rowTitle : WA_LIMITS.multiLabel;
    if (opts.length < 2) issue('Add at least 2 options');
    if (opts.length > max) {
      issue(
        q.type === 'button'
          ? `WhatsApp buttons allow at most ${max} options — use a list question for up to ${WA_LIMITS.maxListRows}`
          : `WhatsApp lists allow at most ${max} options`,
      );
    }
    opts.forEach((o, i) => {
      if (o.label.length > maxLabel) issue(`Option ${i + 1} is longer than ${maxLabel} characters`, ['options', i, 'label']);
    });
    const seenLabels = new Set(opts.map((o) => o.label.toLowerCase()));
    if (seenLabels.size !== opts.length) issue('Option labels must be unique');
    const seenIds = new Set(opts.map((o) => o.id));
    if (seenIds.size !== opts.length) issue('Option ids must be unique');
  });
export type QuestionInput = z.infer<typeof questionInputSchema>;

/** Normalises a validated question (rating gets its fixed scale, text gets none). */
export function normalizeQuestion<T extends QuestionInput>(q: T): T {
  if (q.type === 'rating') return { ...q, options: ratingOptions() };
  if (q.type === 'text') return { ...q, options: null };
  return q;
}

export const giftConfigSchema = z
  .object({
    giftType: z.enum(GIFT_TYPES).default('none'),
    giftValue: z.string().trim().max(120).nullish(),
    // Whole units of the owner's wallet currency. The allowed range depends on the currency (walletLimits) and is enforced by the API.
    giftAmount: z.number().int().min(1).nullish(),
    giftDeliveryMode: z.enum(['immediate', 'batch']).default('immediate'),
    giftMaxCount: z.number().int().min(1).max(100_000).nullish(),
  })
  .superRefine((g, ctx) => {
    const need = (field: string, message: string) => ctx.addIssue({ code: 'custom', message, path: [field] });
    if ((g.giftType === 'airtime' || g.giftType === 'momo') && !g.giftAmount) need('giftAmount', 'Enter the gift amount');
    if ((g.giftType === 'discount' || g.giftType === 'prize_draw' || g.giftType === 'airtime' || g.giftType === 'momo') && !g.giftValue)
      need('giftValue', 'Describe the gift (shown to the participant)');
  });

import { SURVEY_KINDS } from './reminders';

export const surveyInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
  language: z.enum(SURVEY_LANGS).default('fr'),
  customThankYou: z.string().trim().max(500).nullish(),
  scheduledAt: z.coerce.date().nullish(),
  /** 'event' = about something happening now / within days (urgent timing); 'general' = everything else. */
  kind: z.enum(SURVEY_KINDS).default('general'),
  /** Last day answers matter. Required for live-event surveys; optional otherwise. */
  deadlineAt: z.coerce.date().nullish(),
  /** Automatic, single, polite reminders (rules in reminders.ts). Off unless the owner switches them on. */
  autoRemindNonResponders: z.boolean().default(false),
  autoRemindAbandoners: z.boolean().default(false),
  gift: giftConfigSchema.prefault({}), // zod 4: a default is the finished OUTPUT; prefault feeds {} through the schema so that its own defaults apply (what .default({}) did in zod 3)
  questions: z.array(questionInputSchema).max(WA_LIMITS.maxQuestions).default([]),
}).superRefine((s, ctx) => {
  if (s.kind === 'event' && !s.deadlineAt) ctx.addIssue({ code: 'custom', message: 'Add the date of the event: it sets the deadline and the reminder timing', path: ['deadlineAt'] });
});
export type SurveyInput = z.infer<typeof surveyInputSchema>;

/** Checks a survey is complete enough to publish; returns human-readable problems. */
export function publishProblems(s: { questions: Array<{ text: string; type: string; options?: unknown }>; deadlineAt?: Date | null }): string[] {
  const problems: string[] = [];
  if (s.deadlineAt && s.deadlineAt.getTime() <= Date.now()) problems.push('The deadline is in the past: choose a later date');
  if (s.questions.length === 0) problems.push('Add at least one question');
  s.questions.forEach((q, i) => {
    const r = questionInputSchema.safeParse({ ...q, required: true });
    if (!r.success) problems.push(`Question ${i + 1}: ${r.error.issues[0]?.message ?? 'invalid'}`);
  });
  return problems;
}

/** Roughly 30 seconds per question, shown in the invitation ("takes 2 minutes"). */
export const estimateMinutes = (questionCount: number): number => Math.max(1, Math.ceil(questionCount / 2));
