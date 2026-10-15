import { WA_LIMITS, ratingOptions, type QuestionOption, type QuestionType, type SurveyLang } from './survey';

/**
 * Transport-agnostic description of what we send on WhatsApp.
 * The API turns these into Cloud API payloads; the dashboard renders the very same
 * objects as chat bubbles in the "Preview on WhatsApp" panel, so the preview can
 * never diverge from what participants actually receive.
 */
export type OutboundMessage =
  | { kind: 'text'; body: string }
  | { kind: 'buttons'; body: string; buttons: Array<{ id: string; title: string }> }
  | { kind: 'list'; body: string; buttonLabel: string; rows: Array<{ id: string; title: string; description?: string }> };

export interface QuestionLike {
  id: string;
  text: string;
  type: QuestionType;
  options?: QuestionOption[] | null;
  required: boolean;
}

// ---- ids carried in button / list replies --------------------------------------

/** Interactive reply id for an answer. Carries the question id so stale taps can be detected. */
export const answerId = (questionId: string, optionId: string) => `a:${questionId}:${optionId}`;

export function parseAnswerId(id: string): { questionId: string; optionId: string } | null {
  const m = /^a:([^:]+):(.+)$/.exec(id);
  return m ? { questionId: m[1]!, optionId: m[2]! } : null;
}

export type TemplateAction = 'START' | 'DECLINE' | 'CONTINUE';
export const templatePayload = (action: TemplateAction, surveyId: string) => `${action}:${surveyId}`;

export function parseTemplatePayload(p: string): { action: TemplateAction; surveyId: string } | null {
  const m = /^(START|DECLINE|CONTINUE):(.+)$/.exec(p);
  return m ? { action: m[1] as TemplateAction, surveyId: m[2]! } : null;
}

// ---- strings -------------------------------------------------------------------

const en = {
    questionOf: (i: number, n: number) => `Question ${i} of ${n}`,
    typeAnswer: 'Type your answer below.',
    skipHint: 'Reply SKIP to skip this question.',
    multiHint: 'Reply with the numbers of your choices, separated by commas (e.g. 1,3).',
    seeOptions: 'See options',
    rating1: 'Very poor',
    rating5: 'Excellent',
    thankYou: '🎉 Thank you for completing our survey!',
    declined: 'No problem — thank you anyway. If you change your mind, reply START.',
    optedOut: "You've been unsubscribed and won't receive more surveys from us.",
    alreadyDone: "You've already completed this survey. Thank you!",
    resumed: "Welcome back! Let's continue where you left off.",
    badChoice: 'Please pick one of the options in the previous message.',
    badText: 'Please type your answer as a text message.',
    badMulti: 'Please reply with numbers from the list, e.g. 1,3.',
    giftAirtime: (v: string) => `🎁 Your gift: ${v}. It will be sent to this number.`,
    giftMomo: (v: string) => `🎁 Your gift: ${v}. It will be sent to your Mobile Money wallet.`,
    giftDiscount: (code: string, v: string) => `🎁 Your code: *${code}*${v ? ` — ${v}` : ''}`,
    giftDraw: (v: string) => `🎟️ You're entered in the prize draw${v ? ` (${v})` : ''}. Good luck!`,
    giftSent: (v: string, receiptUrl?: string) => `✅ Your gift (${v}) has been sent. Thank you for taking part!${receiptUrl ? `\n\nDownload your receipt: ${receiptUrl}` : ''}`,
} ;

const fr: typeof en = {
    questionOf: (i: number, n: number) => `Question ${i} sur ${n}`,
    typeAnswer: 'Écrivez votre réponse ci-dessous.',
    skipHint: 'Répondez PASSER pour ignorer cette question.',
    multiHint: 'Répondez avec les numéros de vos choix, séparés par des virgules (ex. 1,3).',
    seeOptions: 'Voir les options',
    rating1: 'Très mauvais',
    rating5: 'Excellent',
    thankYou: '🎉 Merci d’avoir répondu à notre sondage !',
    declined: 'Pas de souci, merci quand même. Si vous changez d’avis, répondez START.',
    optedOut: 'Vous êtes désinscrit(e) et ne recevrez plus de sondages de notre part.',
    alreadyDone: 'Vous avez déjà répondu à ce sondage. Merci !',
    resumed: 'Bon retour ! Reprenons là où vous vous étiez arrêté(e).',
    badChoice: 'Merci de choisir l’une des options du message précédent.',
    badText: 'Merci de répondre par un message texte.',
    badMulti: 'Merci de répondre avec des numéros de la liste, ex. 1,3.',
    giftAirtime: (v: string) => `🎁 Votre cadeau : ${v}. Il sera envoyé à ce numéro.`,
    giftMomo: (v: string) => `🎁 Votre cadeau : ${v}. Il sera envoyé sur votre compte Mobile Money.`,
    giftDiscount: (code: string, v: string) => `🎁 Votre code : *${code}*${v ? ` — ${v}` : ''}`,
    giftDraw: (v: string) => `🎟️ Vous participez au tirage au sort${v ? ` (${v})` : ''}. Bonne chance !`,
    giftSent: (v: string, receiptUrl?: string) => `✅ Votre cadeau (${v}) a été envoyé. Merci de votre participation !${receiptUrl ? `

Téléchargez votre reçu : ${receiptUrl}` : ''}`,
};

const STR: Record<SurveyLang, typeof en> = { en, fr };

export const sys = (lang: SurveyLang) => STR[lang] ?? STR.fr;

/** Words that mean "skip" (optional questions only). */
export const SKIP_WORDS = ['skip', 'passer', 'pass'];
export const START_WORDS = ['start', 'commencer', 'démarrer', 'demarrer'];
export const STOP_WORDS = ['stop', 'arret', 'arrêt', 'unsubscribe', 'desabonner', 'désabonner'];

// ---- builders ------------------------------------------------------------------

export function buildQuestionMessage(q: QuestionLike, index: number, total: number, lang: SurveyLang): OutboundMessage {
  const s = sys(lang);
  const head = `*${s.questionOf(index + 1, total)}*\n${q.text}`;
  const skip = q.required ? '' : `\n\n_${s.skipHint}_`;

  switch (q.type) {
    case 'button': {
      const opts = (q.options ?? []).slice(0, WA_LIMITS.maxButtons);
      return {
        kind: 'buttons',
        body: head + skip,
        buttons: opts.map((o) => ({ id: answerId(q.id, o.id), title: o.label.slice(0, WA_LIMITS.buttonTitle) })),
      };
    }
    case 'list': {
      const opts = (q.options ?? []).slice(0, WA_LIMITS.maxListRows);
      return {
        kind: 'list',
        body: head + skip,
        buttonLabel: s.seeOptions,
        rows: opts.map((o) => ({ id: answerId(q.id, o.id), title: o.label.slice(0, WA_LIMITS.rowTitle) })),
      };
    }
    case 'rating': {
      // WhatsApp allows max 3 reply buttons, so a 1–5 scale must be a list message.
      const opts = ratingOptions();
      return {
        kind: 'list',
        body: head + skip,
        buttonLabel: s.seeOptions,
        rows: opts.map((o) => ({
          id: answerId(q.id, o.id),
          title: o.label,
          ...(o.id === '1' ? { description: s.rating1 } : o.id === '5' ? { description: s.rating5 } : {}),
        })),
      };
    }
    case 'multi': {
      const lines = (q.options ?? []).map((o, i) => `${i + 1}. ${o.label}`).join('\n');
      return { kind: 'text', body: `${head}\n\n${lines}\n\n_${s.multiHint}_${skip}` };
    }
    case 'text':
    default:
      return { kind: 'text', body: `${head}\n\n_${s.typeAnswer}_${skip}` };
  }
}

export interface GiftMessageInput {
  giftType: string;
  giftValue?: string | null;
  customThankYou?: string | null;
  code?: string | null;
}

/** Thank-you text (+ gift line) sent in the 24h window right after the last answer. */
export function buildThankYouMessage(g: GiftMessageInput, lang: SurveyLang): string {
  const s = sys(lang);
  const v = g.giftValue ?? '';
  const parts = [s.thankYou];
  switch (g.giftType) {
    case 'airtime': parts.push(s.giftAirtime(v)); break;
    case 'momo': parts.push(s.giftMomo(v)); break;
    case 'discount': if (g.code) parts.push(s.giftDiscount(g.code, v)); break;
    case 'prize_draw': parts.push(s.giftDraw(v)); break;
    default: if (g.customThankYou) parts.push(g.customThankYou);
  }
  return parts.join('\n\n');
}

// ---- templates (business-initiated messages) ------------------------------------

export interface TemplateDef {
  name: string;
  language: SurveyLang;
  /** Meta category. Spec says UTILITY; Meta may re-categorise survey invites as MARKETING. */
  category: 'UTILITY' | 'MARKETING';
  body: string;
  /** Example values Meta requires for each {{n}} variable at submission time. */
  examples: string[];
  /** Quick-reply buttons (their payloads are supplied at send time). */
  buttons: string[];
  /** URL buttons whose link ends with a per-message suffix (e.g. the receipt token). The base URL is deployment config. */
  urlButtons?: string[];
}

export const TEMPLATE_NAMES = {
  invitation: 'survey_invitation',
  reminder: 'survey_reminder',
  giftNotice: 'survey_gift_notice',
  // automatic reminders (see reminders.ts)
  nudge: 'survey_nudge',
  deadlineNote: 'survey_deadline_note',
  progressSaved: 'survey_progress_saved',
  progressSavedDeadline: 'survey_progress_saved_deadline',
} as const;

export const TEMPLATE_DEFS: TemplateDef[] = [
  {
    name: TEMPLATE_NAMES.invitation, language: 'en', category: 'UTILITY',
    body: 'Hello {{1}}! {{2}} invites you to a short survey. It takes about {{3}} minutes.',
    examples: ['Aïcha', 'Boulangerie Akwa', '2'], buttons: ['Start survey', 'Not now'],
  },
  {
    name: TEMPLATE_NAMES.invitation, language: 'fr', category: 'UTILITY',
    body: 'Bonjour {{1}} ! {{2}} vous invite à répondre à un court sondage. Cela prend environ {{3}} minutes.',
    examples: ['Aïcha', 'Boulangerie Akwa', '2'], buttons: ['Commencer', 'Pas maintenant'],
  },
  {
    name: TEMPLATE_NAMES.reminder, language: 'en', category: 'UTILITY',
    body: 'Hi {{1}}, thank you for starting {{2}}\'s survey! Whenever you\'re ready, you can pick up right where you left off.',
    examples: ['Aïcha', 'Boulangerie Akwa'], buttons: ['Continue survey'],
  },
  {
    name: TEMPLATE_NAMES.reminder, language: 'fr', category: 'UTILITY',
    body: 'Bonjour {{1}}, merci d\'avoir commencé le sondage de {{2}} ! Quand vous le souhaitez, vous pouvez reprendre là où vous vous étiez arrêté(e).',
    examples: ['Aïcha', 'Boulangerie Akwa'], buttons: ['Continuer'],
  },
  {
    name: TEMPLATE_NAMES.giftNotice, language: 'en', category: 'UTILITY',
    body: 'Thank you {{1}}! Your gift for completing the survey ({{2}}) has been sent to this number.',
    examples: ['Aïcha', '500 FCFA airtime'], buttons: [], urlButtons: ['Download receipt'],
  },
  {
    name: TEMPLATE_NAMES.giftNotice, language: 'fr', category: 'UTILITY',
    body: 'Merci {{1}} ! Votre cadeau pour avoir répondu au sondage ({{2}}) a été envoyé sur ce numéro.',
    examples: ['Aïcha', '500 FCFA de crédit'], buttons: [], urlButtons: ['Télécharger le reçu'],
  },
  // ---- automatic reminders: warm, short, one ask ------------------------------------------------------
  {
    name: TEMPLATE_NAMES.nudge, language: 'en', category: 'UTILITY',
    body: 'Hi {{1}}, a friendly reminder: {{2}} would really value your opinion in a short survey. It takes about {{3}} minutes, whenever it suits you. Thank you!',
    examples: ['Aïcha', 'Boulangerie Akwa', '2'], buttons: ['Start survey', 'Not now'],
  },
  {
    name: TEMPLATE_NAMES.nudge, language: 'fr', category: 'UTILITY',
    body: 'Bonjour {{1}}, un petit rappel amical : {{2}} aimerait vraiment avoir votre avis dans un court sondage. Cela prend environ {{3}} minutes, quand cela vous convient. Merci !',
    examples: ['Aïcha', 'Boulangerie Akwa', '2'], buttons: ['Commencer', 'Pas maintenant'],
  },
  {
    name: TEMPLATE_NAMES.deadlineNote, language: 'en', category: 'UTILITY',
    body: 'Hi {{1}}, you still have until {{3}} to share your thoughts with {{2}}, and your input is truly valued. We would love for you to start and complete the survey.',
    examples: ['Aïcha', 'Boulangerie Akwa', 'Friday 24 October'], buttons: ['Start survey'],
  },
  {
    name: TEMPLATE_NAMES.deadlineNote, language: 'fr', category: 'UTILITY',
    body: 'Bonjour {{1}}, vous avez encore jusqu’au {{3}} pour partager votre avis avec {{2}}, et votre contribution est vraiment précieuse. Nous serions ravis que vous commenciez et terminiez le sondage.',
    examples: ['Aïcha', 'Boulangerie Akwa', 'vendredi 24 octobre'], buttons: ['Commencer'],
  },
  {
    name: TEMPLATE_NAMES.progressSaved, language: 'en', category: 'UTILITY',
    body: 'Thank you for starting the survey, {{1}}! Your answers so far are saved, so you can continue whenever you like.',
    examples: ['Aïcha'], buttons: ['Continue survey'],
  },
  {
    name: TEMPLATE_NAMES.progressSaved, language: 'fr', category: 'UTILITY',
    body: 'Merci d’avoir commencé le sondage, {{1}} ! Vos réponses sont enregistrées : vous pouvez continuer quand vous le souhaitez.',
    examples: ['Aïcha'], buttons: ['Continuer'],
  },
  {
    name: TEMPLATE_NAMES.progressSavedDeadline, language: 'en', category: 'UTILITY',
    body: 'Thank you for starting the survey, {{1}}! Your answers so far are saved, and you can finish until {{2}} whenever it suits you.',
    examples: ['Aïcha', 'Friday 24 October'], buttons: ['Continue survey'],
  },
  {
    name: TEMPLATE_NAMES.progressSavedDeadline, language: 'fr', category: 'UTILITY',
    body: 'Merci d’avoir commencé le sondage, {{1}} ! Vos réponses sont enregistrées et vous pouvez terminer jusqu’au {{2}}, quand cela vous convient.',
    examples: ['Aïcha', 'vendredi 24 octobre'], buttons: ['Continuer'],
  },
];

export const templateKey = (name: string, language: string) => `${name}:${language}`;
