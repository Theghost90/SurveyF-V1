import type { OutboundMessage } from './wa-messages';
import type { QuestionType } from './survey';

/**
 * Analytics Bot: the owner asks the SurveyFlow WhatsApp number for numbers (STATS, DROP, NONRESP…) and gets short text cards.
 * Everything that decides what a card SAYS lives here, as pure functions, because the API (the real bot) and the survey builder's
 * "Your analytics on WhatsApp" preview must print the same thing: the preview is the bot, with example numbers.
 *
 * Principle (kept from the design): numbers on WhatsApp, charts and full lists in the SaaS. WhatsApp shows names with MASKED numbers
 * (+237 6XX XXX 901); complete numbers exist only inside SurveyFlow (the "haven't started" list and its CSV).
 */

export type BotLocale = 'en' | 'fr';

// ---- question types, said the same way everywhere ---------------------------------------------------------------------------

const TYPE_LABELS: Record<BotLocale, Record<QuestionType, string>> = {
  en: { button: 'Multiple choice · buttons', list: 'Multiple choice · list', multi: 'Several answers allowed', text: 'Free text', rating: 'Rating 1–5' },
  fr: { button: 'Choix multiple · boutons', list: 'Choix multiple · liste', multi: 'Plusieurs réponses possibles', text: 'Texte libre', rating: 'Note 1–5' },
};
/** "Multiple choice · buttons", "Rating 1–5"… shown next to a question's title in the analytics page. */
export const questionTypeLabel = (type: string, locale: BotLocale): string => TYPE_LABELS[locale][type as QuestionType] ?? type;

// ---- the drop-off advice: one rule for the dashboard and the bot ------------------------------------------------------------

export type DropSuggestion = 'make_optional' | 'simplify_options' | 'shorten';
/**
 * What to try at the question people leave from. A long list is the likelier cause whatever else is true; a REQUIRED question can be made
 * optional; one that is already optional can only be asked more simply (the old rule told owners to make an optional question optional).
 */
export function dropSuggestion(q: { required: boolean; optionCount: number }): DropSuggestion {
  if (q.optionCount > 6) return 'simplify_options';
  return q.required ? 'make_optional' : 'shorten';
}

// ---- commands ----------------------------------------------------------------------------------------------------------------

export const BOT_COMMANDS = ['stats', 'results', 'drop', 'nonresp', 'started', 'completed', 'surveys', 'more', 'help', 'link', 'unlink', 'mute', 'unmute'] as const;
export type BotCommand = (typeof BOT_COMMANDS)[number];

/** French and English words, case, accents and punctuation ignored. PERQ is kept as an alias of DROP (it said the same thing). */
const ALIASES: Record<BotCommand, string[]> = {
  stats: ['stats', 'stat', 'statistiques', 'resume', 'bilan', 'summary'],
  results: ['results', 'result', 'resultats', 'resultat'],
  drop: ['drop', 'perq', 'abandons', 'abandon', 'questions'],
  nonresp: ['nonresp', 'nonrep', 'norep', 'noreply', 'sansreponse', 'pasrepondu', 'nonrepondants'],
  started: ['started', 'commence', 'commences', 'encours', 'startedbutnotfinished'],
  completed: ['completed', 'complete', 'termines', 'termine', 'complets', 'finis', 'fini', 'done'],
  surveys: ['surveys', 'survey', 'sondages', 'sondage', 'liste', 'list'],
  more: ['more', 'plus', 'suite', 'next'],
  help: ['help', 'aide', 'menu', 'commands', 'commandes', '?'],
  link: ['link', 'lier'],
  unlink: ['unlink', 'delier', 'dissocier'],
  // alerts: MUTE / SILENCE stop them, UNMUTE (or ALERTS ON / ALERTES OUI) bring them back
  mute: ['mute', 'silence', 'alertsoff', 'alertesoff'],
  unmute: ['unmute', 'alertson', 'alerteson'],
};

const squash = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9?\s]/g, ' ').replace(/\s+/g, ' ').trim();

export interface ParsedCommand {
  command: BotCommand;
  /** "STATS 2": the survey picked from the SURVEYS list (1-based). */
  surveyIndex?: number;
  /** "LINK 7K2M9QXP". */
  code?: string;
  /** "ALL NONRESP": the old way to ask for the full list, which now lives in SurveyFlow. */
  all?: boolean;
}

export function parseBotCommand(text: string): ParsedCommand | null {
  let words = squash(text).split(' ').filter(Boolean);
  if (!words.length) return null;
  // "STATS2" is "STATS 2"
  const glued = /^([a-z]+)(\d{1,2})$/.exec(words[0]!);
  if (glued && !ALIASES.link.includes(glued[1]!)) words = [glued[1]!, glued[2]!, ...words.slice(1)];
  const all = words[0] === 'all' || words[0] === 'tous' || words[0] === 'tout';
  if (all) words = words.slice(1);
  // "no reply" / "sans reponse" / "pas repondu" are two words
  // "ALERTS OFF" / "ALERTES NON" are two words: fold them into one keyword
  if (/^alertes?$|^alerts?$/.test(words[0] ?? '') && words[1]) {
    const on = ['on', 'oui', 'yes'].includes(words[1]), off = ['off', 'non', 'no'].includes(words[1]);
    if (on || off) words = [`alerts${on ? 'on' : 'off'}`, ...words.slice(2)];
  }
  const joined2 = words.slice(0, 2).join('');
  const head = ALIASES.nonresp.includes(joined2) ? joined2 : words[0];
  const rest = ALIASES.nonresp.includes(joined2) ? words.slice(2) : words.slice(1);
  if (!head) return null;
  for (const c of BOT_COMMANDS) {
    if (!ALIASES[c].includes(head)) continue;
    if (c === 'link') return rest[0] ? { command: c, code: rest[0].toUpperCase() } : null;
    const n = rest.find((w) => /^\d{1,2}$/.test(w));
    return { command: c, ...(n ? { surveyIndex: Number(n) } : {}), ...(all ? { all: true } : {}) };
  }
  return null;
}

/** Id carried by the quick-reply buttons / list rows we send: tapping one is the same as typing the word. */
export const botButtonId = (c: BotCommand) => `ab:${c.toUpperCase()}`;
export function parseBotButtonId(id: string): BotCommand | null {
  const m = /^ab:([A-Z]+)$/.exec(id);
  const c = m ? (m[1]!.toLowerCase() as BotCommand) : null;
  return c && (BOT_COMMANDS as readonly string[]).includes(c) ? c : null;
}

// ---- the numbers a card is made of --------------------------------------------------------------------------------------------

export interface BotQuestion {
  number: number; text: string; type: string; required: boolean; optionCount: number;
  /** answered + skipped: people who got past it */ passed: number; abandonedHere: number;
  /** RESULTS: people who ANSWERED it (percentages are of these), the most chosen option, the average of a rating, the count of comments. */
  answered?: number; top?: { label: string; count: number; pct: number } | null; average?: number | null;
}
export interface BotStatsData {
  title: string;
  totals: { sent: number; started: number; completed: number; abandoned: number; inProgress: number; noReply: number; declined: number; optedOut: number; completionRate: number };
  questions: BotQuestion[];
}

/** The slice of the analytics API result the bot reads. Structural: the API passes its own object, the builder passes the fetched JSON. */
export interface AnalyticsLike {
  survey: { title: string };
  totals: { sent: number; started: number; completed: number; abandoned: number; inProgress: number; noReply: number; declined: number; optedOut: number; completionRate: number };
  perQuestion: Array<{ number: number; text: string; type: string; required: boolean; optionCount: number; answered: number; skipped: number; abandonedHere: number; distribution?: Array<{ label: string; count: number; pct: number }>; average?: number | null }>;
}
export const toBotStats = (a: AnalyticsLike): BotStatsData => ({
  title: a.survey.title,
  totals: { ...a.totals },
  questions: a.perQuestion.map((q) => ({
    number: q.number, text: q.text, type: q.type, required: q.required, optionCount: q.optionCount, passed: q.answered + q.skipped, abandonedHere: q.abandonedHere,
    answered: q.answered, average: q.average ?? null,
    top: [...(q.distribution ?? [])].sort((x, y) => y.count - x.count)[0] ?? null,
  })),
});

/**
 * Example numbers for a survey nobody has answered yet (a draft), built from ITS questions so the owner recognises them. They obey the same
 * arithmetic as real ones: started = completed + abandoned + in progress, and sent = started + no reply + declined.
 */
export function exampleBotStats(title: string, questions: Array<{ text: string; type: string; required: boolean; options?: unknown[] | null }>): BotStatsData {
  const totals = { sent: 247, started: 189, completed: 130, abandoned: 34, inProgress: 25, noReply: 51, declined: 7, optedOut: 0, completionRate: 68.8 };
  const n = questions.length;
  // spread the 34 abandons over the questions with a fixed, uneven weighting, so one question stands out
  const weights = questions.map((_, i) => 1 + ((i * 7 + 2) % 5));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (w / wsum) * totals.abandoned);
  const ab = raw.map(Math.floor);
  let left = totals.abandoned - ab.reduce((a, b) => a + b, 0);
  [...raw.keys()].sort((a, b) => (raw[b]! - Math.floor(raw[b]!)) - (raw[a]! - Math.floor(raw[a]!))).forEach((i) => { if (left-- > 0) ab[i]! += 1; });
  const qs: BotQuestion[] = questions.map((q, i) => {
    const after = ab.slice(i + 1).reduce((a, b) => a + b, 0);
    // people still in progress are assumed to be at the last question: they have got past all the others
    const passed = totals.completed + after + (i < n - 1 ? totals.inProgress : 0);
    const answered = passed; // an example survey: everybody who got past a question answered it
    const label = (q.options as Array<{ label?: string }> | null | undefined)?.[0]?.label ?? '…';
    return {
      number: i + 1, text: q.text || '…', type: q.type, required: q.required, optionCount: q.options?.length ?? 0, passed, abandonedHere: ab[i]!,
      answered, average: q.type === 'rating' ? 4.2 : null,
      top: q.type === 'button' || q.type === 'list' || q.type === 'multi' ? { label: label || '…', count: Math.round(answered * 0.62), pct: 62 } : null,
    };
  });
  return { title: title || '…', totals, questions: qs };
}

// ---- the clock on every reply -----------------------------------------------------------------------------------------------

/** "14:32" in the owner's country (fixed UTC offset in minutes: none of the supported countries observes DST). */
export function asOfLabel(at: Date, utcOffsetMinutes: number): string {
  const d = new Date(at.getTime() + utcOffsetMinutes * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ---- words ---------------------------------------------------------------------------------------------------------------------

const S = {
  en: {
    asOf: (t: string) => `as of ${t}`,
    sent: 'Invitations sent', started: 'Started', completed: 'Completed', abandoned: 'Abandoned', inProgress: 'In progress', noReply: 'No reply', declined: 'Declined',
    optedOut: 'Opted out (never contacted again)', rate: 'Completion rate', rateNote: 'completed ÷ started',
    inProgressNote: 'People in progress count as abandoned after 24 h of silence.',
    dropTitle: 'Where people stop', answered: 'got past it', stopped: 'stopped here',
    stillIn: (n: number) => `⏳ ${n} still in progress: not counted as dropped until 24 h of silence.`,
    noDrop: 'Nobody has abandoned this survey yet.',
    highest: (q: number) => `⚠️ Highest dropoff at Q${q}`,
    sug: { make_optional: 'consider making it optional.', simplify_options: 'consider fewer options.', shorten: 'consider making it shorter or clearer.' } as Record<DropSuggestion, string>,
    nonresp: "Haven't replied", startedList: 'Started, not finished', completedList: 'Completed',
    showing: (a: number, b: number) => `showing ${a}–${b}`, nobodyHere: 'Nobody in this list.',
    stoppedAt: (q: number) => `stopped at Q${q}`, atNow: (q: number) => `at Q${q} now`,
    more: 'MORE for the next 10', openSaas: 'Full list with all numbers and CSV export:', openBtn: 'Open in SurveyFlow',
    surveysTitle: 'Your surveys', pickHint: 'Send STATS 2 (or DROP 2…) to pick one. With no number I use survey 1, your most recent active survey.',
    status: { active: 'active', paused: 'paused', closed: 'closed', draft: 'draft' } as Record<string, string>,
    helpTitle: 'SurveyFlow Analytics', helpBody: 'Ask for your numbers any time. Tap a command or type it, in English or French.', helpBtn: 'Commands',
    cmd: { stats: 'Summary', results: 'Answers per question', mute: 'Stop alerts', unmute: 'Turn alerts on', drop: 'Where people stop', nonresp: "Who hasn't replied", started: 'Started, not finished', completed: 'Who finished', surveys: 'Your surveys', more: 'Next 10 of the list', help: 'This list', unlink: 'Remove this phone' } as Record<string, string>,
    linkedOk: (b: string) => `✅ This phone is now linked to ${b}. Send STATS for your numbers, or HELP for all commands.`,
    linkBad: 'That code is not valid any more. Open SurveyFlow → Settings → Analytics on WhatsApp and create a new one (it lasts 15 minutes).',
    linkLimit: 'You already linked 3 phones. Remove one in SurveyFlow (or send UNLINK from it), then try again.',
    linkTaken: 'This phone is linked to another SurveyFlow account. Send UNLINK from it first.',
    unlinked: 'This phone is no longer linked. Your surveys are not affected.',
    notLinked: 'This phone is not linked to a SurveyFlow account. Open SurveyFlow → Settings → Analytics on WhatsApp and tap “Link my WhatsApp”.',
    locked: 'Analytics on WhatsApp is part of the Starter, Growth and Business plans. Activate a plan in SurveyFlow to use it.',
    slowDown: 'You are asking too fast. Wait a few minutes and try again.',
    noSurvey: 'You have no survey with invitations sent yet. Send one from SurveyFlow, then ask again.',
    badIndex: (n: number) => `There is no survey ${n}. Send SURVEYS to see your list.`,
    noList: 'There is no list to continue. Ask for NONRESP, STARTED or COMPLETED first.',
    unknown: 'I did not understand that. Send HELP to see what I can do.',
    allMoved: 'The complete list, with every number and a CSV export, is in SurveyFlow:',
    results: 'Results', resultsNote: 'Percentages are of the people who answered that question.', top: 'Top', average: 'Average', answersOf: (a: number) => `${a} answer${a === 1 ? '' : 's'}`, comments: (n: number) => `${n} comment${n === 1 ? '' : 's'}`, noAnswersYet: 'no answers yet',
    mutedOk: '🔕 Alerts are off for this phone. Send ALERTS ON to turn them back on. STATS and the other commands still work.', unmutedOk: '🔔 Alerts are on: I will message you at milestones (100, 500, 1,000 responses…) and when answers slow down. Send MUTE to stop them.',
    alertMilestone: (n: number, title: string, rate: string) => `🎉 *${n} responses reached*\n${title}\nCompletion rate so far: ${rate}%`, alertSlow: (h: number, title: string) => `⚠️ *Responses are slowing down*\nNo new answers for ${h} hours on “${title}”. Reply NONRESP to see who has not started.`,
    alertFoot: 'Reply STATS for the full summary. MUTE to stop alerts.',
  },
  fr: {
    asOf: (t: string) => `à ${t}`,
    sent: 'Invitations envoyées', started: 'Commencé', completed: 'Terminé', abandoned: 'Abandonné', inProgress: 'En cours', noReply: 'Sans réponse', declined: 'Refus',
    optedOut: 'Désabonnés (plus jamais contactés)', rate: 'Taux de complétion', rateNote: 'terminés ÷ commencés',
    inProgressNote: 'Les personnes en cours sont comptées comme abandons après 24 h de silence.',
    dropTitle: 'Où les gens s’arrêtent', answered: 'ont passé la question', stopped: 's’arrêtent ici',
    stillIn: (n: number) => `⏳ ${n} encore en cours : comptés comme abandons seulement après 24 h de silence.`,
    noDrop: 'Personne n’a encore abandonné ce sondage.',
    highest: (q: number) => `⚠️ Plus fort abandon à la Q${q}`,
    sug: { make_optional: 'pensez à la rendre facultative.', simplify_options: 'pensez à réduire le nombre de choix.', shorten: 'pensez à la raccourcir ou la clarifier.' } as Record<DropSuggestion, string>,
    nonresp: 'N’ont pas répondu', startedList: 'Commencé, pas terminé', completedList: 'Terminé',
    showing: (a: number, b: number) => `affichage ${a}–${b}`, nobodyHere: 'Personne dans cette liste.',
    stoppedAt: (q: number) => `arrêté à la Q${q}`, atNow: (q: number) => `à la Q${q} en ce moment`,
    more: 'PLUS pour les 10 suivants', openSaas: 'Liste complète avec tous les numéros et export CSV :', openBtn: 'Ouvrir SurveyFlow',
    surveysTitle: 'Vos sondages', pickHint: 'Envoyez STATS 2 (ou ABANDONS 2…) pour en choisir un. Sans numéro, j’utilise le sondage 1, votre sondage actif le plus récent.',
    status: { active: 'actif', paused: 'en pause', closed: 'clos', draft: 'brouillon' } as Record<string, string>,
    helpTitle: 'SurveyFlow Analytics', helpBody: 'Demandez vos chiffres à tout moment. Touchez une commande ou tapez-la, en français ou en anglais.', helpBtn: 'Commandes',
    cmd: { stats: 'Résumé', results: 'Réponses par question', mute: 'Arrêter les alertes', unmute: 'Activer les alertes', drop: 'Où les gens s’arrêtent', nonresp: 'Qui n’a pas répondu', started: 'Commencé, pas terminé', completed: 'Qui a terminé', surveys: 'Vos sondages', more: '10 suivants de la liste', help: 'Cette liste', unlink: 'Retirer ce téléphone' } as Record<string, string>,
    linkedOk: (b: string) => `✅ Ce téléphone est maintenant lié à ${b}. Envoyez STATS pour vos chiffres, ou AIDE pour toutes les commandes.`,
    linkBad: 'Ce code n’est plus valable. Ouvrez SurveyFlow → Paramètres → Analytics sur WhatsApp et créez-en un nouveau (il dure 15 minutes).',
    linkLimit: 'Vous avez déjà lié 3 téléphones. Retirez-en un dans SurveyFlow (ou envoyez DELIER depuis celui-ci), puis réessayez.',
    linkTaken: 'Ce téléphone est lié à un autre compte SurveyFlow. Envoyez DELIER depuis celui-ci d’abord.',
    unlinked: 'Ce téléphone n’est plus lié. Vos sondages ne changent pas.',
    notLinked: 'Ce téléphone n’est pas lié à un compte SurveyFlow. Ouvrez SurveyFlow → Paramètres → Analytics sur WhatsApp et touchez « Lier mon WhatsApp ».',
    locked: 'Analytics sur WhatsApp fait partie des forfaits Starter, Growth et Business. Activez un forfait dans SurveyFlow pour l’utiliser.',
    slowDown: 'Vous demandez trop vite. Attendez quelques minutes puis réessayez.',
    noSurvey: 'Vous n’avez pas encore de sondage avec des invitations envoyées. Envoyez-en un depuis SurveyFlow, puis redemandez.',
    badIndex: (n: number) => `Il n’y a pas de sondage ${n}. Envoyez SONDAGES pour voir votre liste.`,
    noList: 'Il n’y a pas de liste à continuer. Demandez d’abord SANSREPONSE, COMMENCE ou TERMINES.',
    unknown: 'Je n’ai pas compris. Envoyez AIDE pour voir ce que je sais faire.',
    allMoved: 'La liste complète, avec tous les numéros et un export CSV, est dans SurveyFlow :',
    results: 'Résultats', resultsNote: 'Les pourcentages sont calculés sur les personnes qui ont répondu à cette question.', top: 'Premier choix', average: 'Moyenne', answersOf: (a: number) => `${a} réponse${a === 1 ? '' : 's'}`, comments: (n: number) => `${n} commentaire${n === 1 ? '' : 's'}`, noAnswersYet: 'pas encore de réponse',
    mutedOk: '🔕 Les alertes sont coupées pour ce téléphone. Envoyez ALERTES OUI pour les remettre. STATS et les autres commandes fonctionnent toujours.', unmutedOk: '🔔 Alertes activées : je vous écris aux paliers (100, 500, 1 000 réponses…) et quand les réponses ralentissent. Envoyez SILENCE pour les arrêter.',
    alertMilestone: (n: number, title: string, rate: string) => `🎉 *${n} réponses atteintes*\n${title}\nTaux de complétion à ce jour : ${rate}%`, alertSlow: (h: number, title: string) => `⚠️ *Les réponses ralentissent*\nAucune nouvelle réponse depuis ${h} heures sur « ${title} ». Répondez SANSREPONSE pour voir qui n’a pas commencé.`,
    alertFoot: 'Répondez STATS pour le résumé complet. SILENCE pour arrêter les alertes.',
  },
} as const;

/** Reply text for the situations that are not a card (not linked, locked plan, rate limit…). */
export type BotNotice = 'notLinked' | 'locked' | 'rate' | 'noSurvey' | 'noList' | 'unknown' | 'linkBad' | 'linkLimit' | 'linkTaken' | 'unlinked';
export const botNotice = (kind: BotNotice, locale: BotLocale): OutboundMessage => ({ kind: 'text', body: kind === 'rate' ? S[locale].slowDown : S[locale][kind] });
export const botBadIndex = (n: number, locale: BotLocale): OutboundMessage => ({ kind: 'text', body: S[locale].badIndex(n) });
export const botLinked = (business: string, locale: BotLocale): OutboundMessage => ({ kind: 'text', body: S[locale].linkedOk(business) });

const chip = (c: BotCommand, locale: BotLocale) => ({ id: botButtonId(c), title: ({ en: { stats: 'STATS', results: 'RESULTS', mute: 'MUTE', unmute: 'ALERTS ON', drop: 'DROP', nonresp: 'NONRESP', started: 'STARTED', completed: 'COMPLETED', more: 'MORE', help: 'HELP', surveys: 'SURVEYS' }, fr: { stats: 'STATS', results: 'RESULTATS', mute: 'SILENCE', unmute: 'ALERTES OUI', drop: 'ABANDONS', nonresp: 'SANSREPONSE', started: 'COMMENCE', completed: 'TERMINES', more: 'PLUS', help: 'AIDE', surveys: 'SONDAGES' } } as Record<BotLocale, Record<string, string>>)[locale][c]! });

/** Interactive messages (buttons) hold at most 1,024 characters of body; a longer card goes out as plain text, without the chips. */
const withChips = (body: string, buttons: Array<{ id: string; title: string }>): OutboundMessage => (body.length > 1000 ? { kind: 'text', body } : { kind: 'buttons', body, buttons });

const head = (icon: string, title: string, sub: string | null, asOf: string, locale: BotLocale) => `${icon} *${title}*${sub ? `\n${sub} · ${S[locale].asOf(asOf)}` : `\n${S[locale].asOf(asOf)}`}`;
const shortQ = (s: string, max = 30) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const fmtRate = (n: number, locale: BotLocale) => (locale === 'fr' ? String(n).replace('.', ',') : String(n));

/** STATS. Every row adds up: started = completed + in progress + abandoned; sent = started + no reply + declined (+ opted out). */
export function botStatsMessage(d: BotStatsData, locale: BotLocale, asOf: string): OutboundMessage {
  const s = S[locale], t = d.totals;
  const lines = [
    head('📊', d.title, null, asOf, locale), '',
    `${s.sent}: ${t.sent}`,
    `${s.started}: ${t.started}`,
    `   ✅ ${s.completed}: ${t.completed}`,
    `   ⏳ ${s.inProgress}: ${t.inProgress}`,
    `   ❌ ${s.abandoned}: ${t.abandoned}`,
    `${s.noReply}: ${t.noReply} · ${s.declined}: ${t.declined}`,
    ...(t.optedOut > 0 ? [`${s.optedOut}: ${t.optedOut}`] : []),
    '', `${s.rate}: ${fmtRate(t.completionRate, locale)}% (${s.rateNote})`,
    ...(t.inProgress > 0 ? ['', `_${s.inProgressNote}_`] : []),
  ];
  return withChips(lines.join('\n'), [chip('drop', locale), chip('nonresp', locale), chip('help', locale)]);
}

/** DROP (and its alias PERQ): per question, who got past it and who confirmed-abandoned at it. In-progress people are shown apart. */
export function botDropMessage(d: BotStatsData, locale: BotLocale, asOf: string): OutboundMessage {
  const s = S[locale];
  const lines = [head('📉', d.title, s.dropTitle, asOf, locale), ''];
  for (const q of d.questions.slice(0, 25)) lines.push(`Q${q.number} (${shortQ(q.text)}) → ${q.passed} ${s.answered} · ${q.abandonedHere} ${s.stopped}`);
  if (d.totals.inProgress > 0) lines.push('', s.stillIn(d.totals.inProgress));
  const worst = [...d.questions].sort((a, b) => b.abandonedHere - a.abandonedHere)[0];
  if (!worst || worst.abandonedHere === 0) lines.push('', s.noDrop);
  else lines.push('', `${s.highest(worst.number)}: ${s.sug[dropSuggestion(worst)]}`);
  return withChips(lines.join('\n'), [chip('stats', locale), chip('nonresp', locale), chip('help', locale)]);
}

/** "stopped at Q3" for someone who abandoned, "at Q3 now" for someone still answering. */
export const botStartedNote = (status: string, q: number | null, locale: BotLocale): string | undefined =>
  q === null ? undefined : status === 'abandoned' ? S[locale].stoppedAt(q) : S[locale].atNow(q);

export interface BotListRow { name: string; /** already masked */ phone: string; note?: string }
export type BotListKind = 'nonresp' | 'started' | 'completed';

/** One page (up to 10) of a list: name + MASKED number. `MORE` continues it; the full list with every number is in SurveyFlow. */
export function botListMessages(kind: BotListKind, title: string, rows: BotListRow[], total: number, offset: number, locale: BotLocale, asOf: string, openUrl: string | null): OutboundMessage[] {
  const s = S[locale];
  const label = kind === 'nonresp' ? s.nonresp : kind === 'started' ? s.startedList : s.completedList;
  const lines = [head('👥', title, `${label}: ${total}${total > 0 ? ` · ${s.showing(offset + 1, offset + rows.length)}` : ''}`, asOf, locale), ''];
  if (!rows.length) lines.push(s.nobodyHere);
  rows.forEach((r, i) => lines.push(`${offset + i + 1}. ${r.name} · ${r.phone}${r.note ? ` · ${r.note}` : ''}`));
  const hasMore = offset + rows.length < total;
  if (hasMore) lines.push('', s.more);
  const first = withChips(lines.join('\n'), [hasMore ? chip('more', locale) : chip('stats', locale), chip('drop', locale), chip('help', locale)]);
  return openUrl && kind === 'nonresp' ? [first, { kind: 'link', body: s.openSaas, buttonLabel: s.openBtn, url: openUrl }] : [first];
}

/** "ALL NONRESP" (the design's export command): the full list is a SurveyFlow feature now, so answer with the button to it. */
export const botOpenSaasMessage = (locale: BotLocale, url: string): OutboundMessage => ({ kind: 'link', body: S[locale].allMoved, buttonLabel: S[locale].openBtn, url });

export interface BotSurveyRow { title: string; status: string; sent: number; completed: number }
export function botSurveysMessage(rows: BotSurveyRow[], locale: BotLocale, asOf: string): OutboundMessage {
  const s = S[locale];
  const lines = [head('📋', s.surveysTitle, null, asOf, locale), ''];
  rows.forEach((r, i) => lines.push(`${i + 1}. ${shortQ(r.title, 36)} · ${s.status[r.status] ?? r.status} · ${r.completed}/${r.sent}`));
  lines.push('', s.pickHint);
  return withChips(lines.join('\n'), [chip('stats', locale), chip('drop', locale), chip('help', locale)]);
}

/** HELP: a list of the commands (WhatsApp shows it as a menu; each row is one tap). */
export function botHelpMessage(locale: BotLocale): OutboundMessage {
  const s = S[locale];
  const rows = (['stats', 'results', 'drop', 'nonresp', 'started', 'completed', 'surveys', 'mute', 'unmute', 'unlink'] as const).map((c) => ({
    id: botButtonId(c), title: c === 'unlink' ? (locale === 'fr' ? 'DELIER' : 'UNLINK') : chip(c as BotCommand, locale).title, description: s.cmd[c],
  }));
  return { kind: 'list', body: `🤖 *${s.helpTitle}*\n${s.helpBody}`, buttonLabel: s.helpBtn, rows };
}


// ---- RESULTS: one line per question ------------------------------------------------------------------------------------------------

/**
 * RESULTS. The share and the count come with the top choice ("Top: Satisfied · 62% (81 of 130)"), never the name alone: 51% and 49% must not
 * read like a landslide. Percentages are of the people who answered THAT question; the dashboard has the full distribution.
 */
export function botResultsMessages(d: BotStatsData, locale: BotLocale, asOf: string, openUrl: string | null): OutboundMessage[] {
  const s = S[locale];
  const lines = [head('📋', d.title, `${s.results} · ${d.totals.completed} ${s.completed.toLowerCase()}`, asOf, locale), ''];
  for (const q of d.questions.slice(0, 15)) {
    const n = q.answered ?? q.passed;
    lines.push(`Q${q.number} ${shortQ(q.text, 34)} (${questionTypeLabel(q.type, locale)})`);
    if (n === 0) lines.push(`→ ${s.noAnswersYet}`);
    else if (q.type === 'text') lines.push(`→ ${s.comments(n)}`);
    else if (q.type === 'rating') lines.push(`→ ${s.average} ${q.average === null || q.average === undefined ? '—' : fmtRate(q.average, locale)} (${s.answersOf(n)})`);
    else lines.push(q.top ? `→ ${s.top}: ${shortQ(q.top.label, 28)} · ${Math.round(q.top.pct)}% (${q.top.count}/${n})` : `→ ${s.answersOf(n)}`);
    lines.push('');
  }
  lines.push(`_${s.resultsNote}_`);
  const first = withChips(lines.join('\n'), [chip('stats', locale), chip('drop', locale), chip('help', locale)]);
  return openUrl ? [first, { kind: 'link', body: locale === 'fr' ? 'Graphiques complets et filtres :' : 'Full charts and filters:', buttonLabel: s.openBtn, url: openUrl }] : [first];
}

// ---- push alerts ---------------------------------------------------------------------------------------------------------------------

export const ALERT_MILESTONES = [100, 500, 1000, 5000, 10000] as const;
export type AlertKind = 'milestone' | 'slowdown';

/** The text of an alert, as a message inside an open 24 h window (free) … */
export function botAlertMessage(kind: AlertKind, p: { title: string; n?: number; rate?: number; hours?: number }, locale: BotLocale): OutboundMessage {
  const s = S[locale];
  const body = kind === 'milestone' ? s.alertMilestone(p.n ?? 0, p.title, fmtRate(p.rate ?? 0, locale)) : s.alertSlow(p.hours ?? 48, p.title);
  return { kind: 'buttons', body: `${body}\n\n${s.alertFoot}`, buttons: [chip(kind === 'slowdown' ? 'nonresp' : 'stats', locale), { id: botButtonId('mute'), title: chip('mute', locale).title }] };
}
/** … and the same words as the single {{1}} of the approved template (a template variable cannot hold line breaks). */
export function botAlertTemplateText(kind: AlertKind, p: { title: string; n?: number; rate?: number; hours?: number }, locale: BotLocale): string {
  const s = S[locale];
  const body = kind === 'milestone' ? s.alertMilestone(p.n ?? 0, p.title, fmtRate(p.rate ?? 0, locale)) : s.alertSlow(p.hours ?? 48, p.title);
  return body.replace(/\*/g, '').replace(/\s*\n\s*/g, ' · ').slice(0, 240);
}
export const botMuted = (on: boolean, locale: BotLocale): OutboundMessage => ({ kind: 'text', body: on ? S[locale].unmutedOk : S[locale].mutedOk });

/** The template the platform number uses to reach an owner OUTSIDE the 24 h window (utility; quick replies reopen the window for free answers). */
export const OWNER_ALERT_TEMPLATE = 'owner_alert';
export const OWNER_ALERT_DEFS = [
  { name: OWNER_ALERT_TEMPLATE, language: 'en' as const, category: 'UTILITY' as const, body: 'SurveyFlow alert: {{1}} Tap STATS for the full summary.', examples: ['100 responses reached on Customer Satisfaction. Completion rate so far: 68.8%.'], buttons: ['STATS', 'Mute alerts'] },
  { name: OWNER_ALERT_TEMPLATE, language: 'fr' as const, category: 'UTILITY' as const, body: 'Alerte SurveyFlow : {{1}} Touchez STATS pour le résumé complet.', examples: ['100 réponses atteintes sur Satisfaction client. Taux de complétion à ce jour : 68,8%.'], buttons: ['STATS', 'Couper les alertes'] },
];
export const OWNER_ALERT_PAYLOADS = [botButtonId('stats'), botButtonId('mute')];
