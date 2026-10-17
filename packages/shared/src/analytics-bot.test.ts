import { describe, expect, it } from 'vitest';
import { botAlertTemplateText, botResultsMessages, exampleBotStats, parseBotCommand } from './analytics-bot';

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
