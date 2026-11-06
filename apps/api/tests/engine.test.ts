import { describe, expect, it } from 'vitest';
import { answerId } from '@surveyflow/shared';
import { parseTypedAnswer, step, type RuntimeSurvey, type SessionState } from '../src/services/survey/engine';

const survey = (over: Partial<RuntimeSurvey> = {}): RuntimeSurvey => ({
  id: 's1', language: 'en', status: 'active',
  questions: [
    { id: 'q1', order: 0, text: 'How satisfied?', type: 'button', required: true, options: [{ id: 'a', label: 'Good' }, { id: 'b', label: 'Bad' }] },
    { id: 'q2', order: 1, text: 'Product?', type: 'list', required: true, options: [{ id: 'p1', label: 'Alpha' }, { id: 'p2', label: 'Beta' }, { id: 'p3', label: 'Gamma' }] },
    { id: 'q3', order: 2, text: 'Suggestions?', type: 'text', required: false, options: null },
  ],
  ...over,
});
const now = new Date('2026-10-05T10:00:00Z');
const sess = (over: Partial<SessionState> = {}): SessionState => ({
  surveyId: 's1', contactId: 'c1', recipientId: 'r1', phoneNumberId: 'pn1', currentIndex: 0, startedAt: now.toISOString(), lastInteractionAt: now.toISOString(), ...over,
});
const run = (over: Partial<Parameters<typeof step>[0]>) =>
  step({ survey: survey(), session: null, recipientStatus: 'delivered', answeredIds: new Set(), inbound: { kind: 'start' }, now, ...over });

describe('survey engine', () => {
  it('START begins at Q1 and creates a session', () => {
    const r = run({});
    expect(r.event).toBe('started');
    expect(r.session?.currentIndex).toBe(0);
    expect(r.messages[0]).toMatchObject({ kind: 'buttons' });
  });

  it('answers advance one question at a time and persist the option LABEL', () => {
    const r = run({ session: sess(), inbound: { kind: 'choice', questionId: 'q1', optionId: 'a' } });
    expect(r.event).toBe('answered');
    expect(r.saveAnswer).toEqual({ questionId: 'q1', answer: 'Good' });
    expect(r.session?.currentIndex).toBe(1);
    expect(r.messages[0]).toMatchObject({ kind: 'list' });
  });

  it('completes on the last answer and clears the session', () => {
    const r = run({ session: sess({ currentIndex: 2 }), inbound: { kind: 'text', body: 'Faster delivery please' } });
    expect(r.event).toBe('completed');
    expect(r.session).toBeNull();
    expect(r.saveAnswer).toEqual({ questionId: 'q3', answer: 'Faster delivery please' });
  });

  it('ignores a tap on an OLD question\'s button (stale) and re-asks the current one', () => {
    const r = run({ session: sess({ currentIndex: 1 }), inbound: { kind: 'choice', questionId: 'q1', optionId: 'b' } });
    expect(r.event).toBe('stale');
    expect(r.saveAnswer).toBeUndefined();
    expect(r.session?.currentIndex).toBe(1);
  });

  it('rejects an unknown option id without advancing', () => {
    const r = run({ session: sess(), inbound: { kind: 'choice', questionId: 'q1', optionId: 'zzz' } });
    expect(r.event).toBe('invalid');
    expect(r.saveAnswer).toBeUndefined();
  });

  it('accepts a typed number or label for a choice question', () => {
    expect(run({ session: sess({ currentIndex: 1 }), inbound: { kind: 'text', body: '2' } }).saveAnswer?.answer).toBe('Beta');
    expect(run({ session: sess({ currentIndex: 1 }), inbound: { kind: 'text', body: ' gamma ' } }).saveAnswer?.answer).toBe('Gamma');
    expect(run({ session: sess({ currentIndex: 1 }), inbound: { kind: 'text', body: 'banana' } }).event).toBe('invalid');
  });

  it('lets optional questions be skipped (stores an empty answer) but not required ones', () => {
    expect(run({ session: sess({ currentIndex: 2 }), inbound: { kind: 'text', body: 'skip' } })).toMatchObject({ event: 'completed', saveAnswer: { answer: '' } });
    expect(run({ session: sess({ currentIndex: 0 }), inbound: { kind: 'text', body: 'skip' } }).event).toBe('invalid');
  });

  it('declined: "Not now" before starting; but not after progress was made', () => {
    expect(run({ inbound: { kind: 'decline' } }).event).toBe('declined');
    expect(run({ session: sess(), inbound: { kind: 'decline' } }).event).toBe('ignored');
    expect(run({ answeredIds: new Set(['q1']), inbound: { kind: 'decline' } }).event).toBe('ignored');
  });

  it('resumes after abandonment at the first unanswered question', () => {
    const r = run({ recipientStatus: 'abandoned', answeredIds: new Set(['q1']), inbound: { kind: 'continue' } });
    expect(r.event).toBe('resumed');
    expect(r.session?.currentIndex).toBe(1);
    expect(r.messages).toHaveLength(2);
  });

  it('a second START mid-survey re-sends the current question instead of restarting', () => {
    const r = run({ session: sess({ currentIndex: 1 }), answeredIds: new Set(['q1']), inbound: { kind: 'start' } });
    expect(r.event).toBe('repeated');
    expect(r.session?.currentIndex).toBe(1);
  });

  it('completed participants cannot restart (no second gift)', () => {
    expect(run({ recipientStatus: 'completed' }).event).toBe('already_completed');
  });

  it('closed/draft surveys refuse answers; paused ones finish in-flight sessions only', () => {
    expect(run({ survey: survey({ status: 'closed' }) }).event).toBe('closed');
    expect(run({ survey: survey({ status: 'paused' }) }).event).toBe('closed');
    const inflight = run({ survey: survey({ status: 'paused' }), session: sess(), inbound: { kind: 'choice', questionId: 'q1', optionId: 'a' } });
    expect(inflight.event).toBe('answered');
  });

  it('random chatter with no session is ignored (the owner may be chatting via Coexistence)', () => {
    expect(run({ inbound: { kind: 'text', body: 'hello, do you have bread?' } }).event).toBe('ignored');
    expect(run({ inbound: { kind: 'unsupported' } }).messages).toHaveLength(0);
  });

  it('non-text media to a text question asks for text', () => {
    const r = run({ session: sess({ currentIndex: 2 }), inbound: { kind: 'unsupported' } });
    expect(r.event).toBe('invalid');
  });

  it('answer ids produced by the shared builder are accepted', () => {
    const r = run({ session: sess(), inbound: { kind: 'choice', questionId: 'q1', optionId: 'b' } });
    expect(r.saveAnswer?.answer).toBe('Bad');
    expect(answerId('q1', 'b')).toBe('a:q1:b');
  });
});

describe('typed answers', () => {
  const rating = { id: 'r', order: 0, text: 'Rate', type: 'rating' as const, required: true, options: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: String(n) })) };
  const multi = { id: 'm', order: 0, text: 'Pick', type: 'multi' as const, required: true, options: [{ id: 'a', label: 'Red' }, { id: 'b', label: 'Blue' }, { id: 'c', label: 'Green' }] };
  it('rating accepts 1-5 only', () => {
    expect(parseTypedAnswer(rating, '4')).toEqual({ answer: '4' });
    expect(parseTypedAnswer(rating, '6')).toEqual({ error: 'choice' });
  });
  it('multi parses "1,3" / "1 3", dedupes, validates range, stores JSON labels', () => {
    expect(parseTypedAnswer(multi, '1,3')).toEqual({ answer: '["Red","Green"]' });
    expect(parseTypedAnswer(multi, '3 3 1')).toEqual({ answer: '["Red","Green"]' });
    expect(parseTypedAnswer(multi, '4')).toEqual({ error: 'multi' });
    expect(parseTypedAnswer(multi, 'red')).toEqual({ error: 'multi' });
  });
});
