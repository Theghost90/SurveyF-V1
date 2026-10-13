import {
  SKIP_WORDS, buildQuestionMessage, sys,
  type OutboundMessage, type QuestionOption, type QuestionType, type SurveyLang,
} from '@surveyflow/shared';

/**
 * Survey engine — a PURE state machine (no I/O), so every transition is unit-testable.
 *
 *   not_started ──START tapped──────────▶ in_progress   (deviation from the spec, see below)
 *   in_progress ──answer Qn (n<total)──▶ in_progress
 *   in_progress ──answer Q_last────────▶ completed
 *   in_progress ──24h silence──────────▶ abandoned       (sweeper, not this module)
 *   not_started ──"Not now"────────────▶ declined
 *   abandoned / declined ──START/CONTINUE──▶ in_progress (resume)
 *
 * Deviation from the spec: it moves to in_progress when the participant "answers Q1".
 * But Q1 is only shown once they tap Start, so someone who taps Start, sees Q1 and leaves
 * would stay "not started" forever and be counted as "no reply" — and abandonment at Q1,
 * usually the biggest drop-off, would be invisible. We therefore start on the Start tap.
 */

export type SurveyRuntimeStatus = 'draft' | 'active' | 'paused' | 'closed';

export interface RuntimeQuestion {
  id: string;
  order: number;
  text: string;
  type: QuestionType;
  options: QuestionOption[] | null;
  required: boolean;
}

export interface RuntimeSurvey {
  id: string;
  language: SurveyLang;
  status: SurveyRuntimeStatus;
  questions: RuntimeQuestion[];
}

export interface SessionState {
  surveyId: string;
  contactId: string;
  recipientId: string;
  phoneNumberId: string;
  /** Index (0-based) of the question the participant is currently answering. */
  currentIndex: number;
  startedAt: string;
  lastInteractionAt: string;
}

export type Inbound =
  | { kind: 'start' }
  | { kind: 'continue' }
  | { kind: 'decline' }
  | { kind: 'choice'; questionId: string; optionId: string }
  | { kind: 'text'; body: string }
  | { kind: 'unsupported' };

export type StepEvent =
  | 'started' // fresh start, Q1 sent
  | 'resumed' // came back after abandon / reminder
  | 'repeated' // START tapped again mid-survey: current question re-sent
  | 'answered' // answer stored, next question sent
  | 'completed' // last answer stored
  | 'declined'
  | 'invalid' // answer not understood, question re-sent
  | 'stale' // tapped a button of an earlier question
  | 'already_completed'
  | 'closed' // survey no longer accepting answers
  | 'ignored'; // nothing to do (e.g. random chat with the business)

export interface StepResult {
  event: StepEvent;
  /** Session to persist; null = no active session afterwards. */
  session: SessionState | null;
  messages: OutboundMessage[];
  /** Answer to persist. An empty string means "skipped an optional question". */
  saveAnswer?: { questionId: string; answer: string };
}

export interface StepInput {
  survey: RuntimeSurvey;
  session: SessionState | null;
  /** Funnel status of the recipient row for this survey. */
  recipientStatus: string;
  /** Questions already answered (or skipped) in the database. */
  answeredIds: ReadonlySet<string>;
  inbound: Inbound;
  now: Date;
}

const ordered = (s: RuntimeSurvey) => [...s.questions].sort((a, b) => a.order - b.order);

function firstUnanswered(qs: RuntimeQuestion[], answered: ReadonlySet<string>): number {
  const i = qs.findIndex((q) => !answered.has(q.id));
  return i === -1 ? qs.length : i;
}

function ask(survey: RuntimeSurvey, qs: RuntimeQuestion[], index: number): OutboundMessage {
  return buildQuestionMessage(qs[index]!, index, qs.length, survey.language);
}

/** Interprets a typed reply for the current question. Returns the stored answer, '' for skip, or null if invalid. */
export function parseTypedAnswer(q: RuntimeQuestion, bodyRaw: string): { answer: string } | { error: 'choice' | 'text' | 'multi' } {
  const body = bodyRaw.trim();
  const opts = q.options ?? [];

  if (!q.required && SKIP_WORDS.includes(body.toLowerCase())) return { answer: '' };

  switch (q.type) {
    case 'text': {
      if (!body) return { error: 'text' };
      return { answer: body.slice(0, 2000) };
    }
    case 'button':
    case 'list':
    case 'rating': {
      if (/^\d{1,2}$/.test(body)) {
        // Rating options are labelled "1".."5", so match the label first; otherwise treat as a 1-based position.
        const byLabel = opts.find((o) => o.label === body);
        if (byLabel) return { answer: byLabel.label };
        const pos = Number(body);
        if (q.type !== 'rating' && pos >= 1 && pos <= opts.length) return { answer: opts[pos - 1]!.label };
      }
      const byText = opts.find((o) => o.label.toLowerCase() === body.toLowerCase());
      return byText ? { answer: byText.label } : { error: 'choice' };
    }
    case 'multi': {
      const nums = body.split(/[\s,;]+/).filter(Boolean);
      if (!nums.length || nums.some((n) => !/^\d{1,2}$/.test(n))) return { error: 'multi' };
      const idx = [...new Set(nums.map(Number))];
      if (idx.some((n) => n < 1 || n > opts.length)) return { error: 'multi' };
      return { answer: JSON.stringify(idx.sort((a, b) => a - b).map((n) => opts[n - 1]!.label)) };
    }
  }
}

export function step(input: StepInput): StepResult {
  const { survey, session, inbound, now, answeredIds } = input;
  const s = sys(survey.language);
  const qs = ordered(survey);
  const iso = now.toISOString();
  const noop = (event: StepEvent, messages: OutboundMessage[] = []): StepResult => ({ event, session, messages });

  // ---- survey availability -------------------------------------------------------
  if (survey.status === 'closed' || survey.status === 'draft') {
    return { event: 'closed', session: null, messages: [{ kind: 'text', body: survey.language === 'fr' ? 'Ce sondage est terminé. Merci !' : 'This survey has ended. Thank you!' }] };
  }
  if (qs.length === 0) return { event: 'ignored', session: null, messages: [] };

  // ---- entry points: start / continue / decline ------------------------------------
  if (inbound.kind === 'start' || inbound.kind === 'continue') {
    if (input.recipientStatus === 'completed') {
      return { event: 'already_completed', session: null, messages: [{ kind: 'text', body: s.alreadyDone }] };
    }
    // Paused surveys finish what is in flight but do not accept new participants.
    if (survey.status === 'paused' && !session && answeredIds.size === 0) {
      return { event: 'closed', session: null, messages: [{ kind: 'text', body: survey.language === 'fr' ? 'Ce sondage est en pause pour le moment.' : 'This survey is paused for now.' }] };
    }
    const idx = firstUnanswered(qs, answeredIds);
    if (idx >= qs.length) {
      // Every question already has an answer but completion was never recorded (e.g. crash): finish now.
      return { event: 'completed', session: null, messages: [] };
    }
    const base: SessionState = {
      surveyId: survey.id,
      contactId: session?.contactId ?? '',
      recipientId: session?.recipientId ?? '',
      phoneNumberId: session?.phoneNumberId ?? '',
      currentIndex: idx,
      startedAt: session?.startedAt ?? iso,
      lastInteractionAt: iso,
    };
    if (session && session.surveyId === survey.id) {
      return { event: 'repeated', session: { ...session, currentIndex: idx, lastInteractionAt: iso }, messages: [ask(survey, qs, idx)] };
    }
    const resumed = answeredIds.size > 0;
    return {
      event: resumed ? 'resumed' : 'started',
      session: base,
      messages: resumed ? [{ kind: 'text', body: s.resumed }, ask(survey, qs, idx)] : [ask(survey, qs, idx)],
    };
  }

  if (inbound.kind === 'decline') {
    // "Not now" on an old invitation after already taking part must not wipe progress.
    if (session || answeredIds.size > 0 || input.recipientStatus === 'completed') return noop('ignored');
    return { event: 'declined', session: null, messages: [{ kind: 'text', body: s.declined }] };
  }

  // ---- everything else needs an active session ---------------------------------------
  if (!session || session.surveyId !== survey.id) return noop('ignored');

  const idx = Math.min(session.currentIndex, qs.length - 1);
  const q = qs[idx]!;
  const touched: SessionState = { ...session, currentIndex: idx, lastInteractionAt: iso };

  let answer: string | null = null;
  let errorKind: 'choice' | 'text' | 'multi' | null = null;

  if (inbound.kind === 'choice') {
    if (inbound.questionId !== q.id) {
      // A tap on an older question's button (the chat history is scrollable). Don't corrupt state.
      return { event: 'stale', session: touched, messages: [ask(survey, qs, idx)] };
    }
    const opt = (q.options ?? []).find((o) => o.id === inbound.optionId);
    if (!opt) errorKind = 'choice';
    else answer = opt.label;
  } else if (inbound.kind === 'text') {
    const r = parseTypedAnswer(q, inbound.body);
    if ('answer' in r) answer = r.answer;
    else errorKind = r.error;
  } else {
    errorKind = q.type === 'text' ? 'text' : 'choice';
  }

  if (answer === null) {
    const hint = errorKind === 'multi' ? s.badMulti : errorKind === 'text' ? s.badText : s.badChoice;
    return { event: 'invalid', session: touched, messages: [{ kind: 'text', body: hint }, ask(survey, qs, idx)] };
  }

  const save = { questionId: q.id, answer };
  const next = idx + 1;
  if (next >= qs.length) {
    return { event: 'completed', session: null, messages: [], saveAnswer: save };
  }
  return { event: 'answered', session: { ...touched, currentIndex: next }, messages: [ask(survey, qs, next)], saveAnswer: save };
}
