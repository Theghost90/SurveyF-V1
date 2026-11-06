import { describe, expect, it } from 'vitest';
import { botAlertTemplateText, botResultsMessages, botSurveysMessage, exampleBotStats, parseBotCommand, toBotStats, type AnalyticsLike } from './analytics-bot';

const qs = [
  { text: 'How satisfied are you?', type: 'button', required: true, options: [{ label: 'Very satisfied' }, { label: 'Neutral' }] },
  { text: 'Recommend us?', type: 'rating', required: true, options: null },
  { text: 'Anything else?', type: 'text', required: false, options: null },
];

describe('analytics bot: RESULTS and alerts', () => {
  it('example numbers give a choice question a top answer WITH its share, a rating an average, a text a count', () => {
    const d = exampleBotStats('Customer Satisfaction', qs);
    expect(d.questions[0]!.top).toMatchObject({ label: 'Very satisfied', pct: 62 });
    expect(d.questions[1]!.average).toBe(4.2);
    const body = (botResultsMessages(d, 'en', '14:32', null)[0] as { body: string }).body;
    expect(body).toMatch(/Top: Very satisfied · 62% \(\d+\/\d+\)/);
    expect(body).toMatch(/Average 4\.2/);
    expect(body).toMatch(/\(Free text\)\n→ \d+ comments/);
  });
  it('parses RESULTS (FR/EN, accents) and the alert switches', () => {
    for (const w of ['RESULTS', 'résultats', 'Resultat']) expect(parseBotCommand(w)?.command, w).toBe('results');
    for (const w of ['MUTE', 'silence', 'alerts off', 'ALERTES NON']) expect(parseBotCommand(w)?.command, w).toBe('mute');
    for (const w of ['unmute', 'alerts on', 'alertes oui']) expect(parseBotCommand(w)?.command, w).toBe('unmute');
    expect(parseBotCommand('results 2')).toMatchObject({ command: 'results', surveyIndex: 2 });
  });
  it('the template text is one line, without markdown (a template variable cannot hold line breaks)', () => {
    const t = botAlertTemplateText('milestone', { title: 'Customer Satisfaction', n: 100, rate: 68.8 }, 'en');
    expect(t).toBe('🎉 100 responses reached · Customer Satisfaction · Completion rate so far: 68.8%');
    expect(botAlertTemplateText('slowdown', { title: 'T', hours: 48 }, 'fr')).not.toMatch(/\n|\*/);
  });
});

describe('analytics bot: RESULTS shows ties and skips, SURVEYS does not claim an active survey (found on the real number, 2026-11-05)', () => {
  const analytics = (over: Partial<AnalyticsLike['perQuestion'][number]>[]): AnalyticsLike => ({
    survey: { title: 'Event feedback' },
    totals: { sent: 1, started: 1, completed: 1, abandoned: 0, inProgress: 0, noReply: 0, declined: 0, optedOut: 0, completionRate: 100 },
    perQuestion: over.map((o, i) => ({ number: i + 1, text: `Question ${i + 1}`, type: 'multi', required: false, optionCount: 5, answered: 1, skipped: 0, abandonedHere: 0, ...o })) as AnalyticsLike['perQuestion'],
  });
  const body = (d: ReturnType<typeof toBotStats>, l: 'en' | 'fr') => (botResultsMessages(d, l, '20:29', null)[0] as { body: string }).body;

  it('two options with the same count are both named, as a tie', () => {
    const d = toBotStats(analytics([{ distribution: [{ label: 'Speakers', count: 1, pct: 100 }, { label: 'Venue', count: 0, pct: 0 }, { label: 'Food', count: 1, pct: 100 }] }]));
    expect(d.questions[0]!.tied).toEqual([{ label: 'Food', count: 1, pct: 100 }]);
    expect(body(d, 'en')).toContain('Tied for top: Speakers · 100% (1/1), Food · 100% (1/1)');
    expect(body(d, 'fr')).toContain('Ex æquo en tête: Speakers · 100% (1/1), Food · 100% (1/1)'); // no space before the colon, like the existing "Premier choix:"
  });
  it('a single leader is still shown as before, and an all-zero question has no tie', () => {
    const one = toBotStats(analytics([{ distribution: [{ label: 'Speakers', count: 2, pct: 67 }, { label: 'Food', count: 1, pct: 33 }], answered: 3 }]));
    expect(body(one, 'en')).toContain('Top: Speakers · 67% (2/3)');
    expect(one.questions[0]!.tied).toEqual([]);
    const none = toBotStats(analytics([{ answered: 0, distribution: [{ label: 'A', count: 0, pct: 0 }, { label: 'B', count: 0, pct: 0 }] }]));
    expect(none.questions[0]!.tied).toEqual([]);
  });
  it('more than three tied options name three and count the rest', () => {
    const dist = ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, count: 1, pct: 20 }));
    const d = toBotStats(analytics([{ answered: 5, distribution: dist }]));
    expect(body(d, 'en')).toMatch(/Tied for top: A · 20% \(1\/5\), B · 20% \(1\/5\), C · 20% \(1\/5\) \+2/);
  });
  it('skipped questions say so, with or without answers', () => {
    const d = toBotStats(analytics([{ type: 'text', answered: 0, skipped: 1 }, { type: 'rating', answered: 2, skipped: 3, average: 4 }]));
    const en = body(d, 'en');
    expect(en).toContain('→ no answers yet · 1 skipped');
    expect(en).toMatch(/Average 4 \(2 answers\) · 3 skipped/);
    expect(body(d, 'fr')).toMatch(/1 ignorée\b/);
    expect(body(toBotStats(analytics([{ type: 'text', answered: 0, skipped: 0 }])), 'en')).not.toContain('skipped');
  });
  it('the survey list does not call survey 1 "active" (it may be closed)', () => {
    const m = botSurveysMessage([{ title: 'Event feedback', status: 'closed', sent: 1, completed: 1 }], 'en', '20:28') as { body: string };
    expect(m.body).toContain('survey 1, the first in this list (active surveys come first)');
    expect(m.body).not.toContain('your most recent active survey');
  });
});
