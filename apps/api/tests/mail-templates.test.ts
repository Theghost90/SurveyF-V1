import { describe, expect, it } from 'vitest';
import { greetingName, renderMail } from '../src/services/mail/templates';

/**
 * Anybody can type anything into the sign-up form, and the confirmation e-mail goes to the address they typed, which may be a stranger's. These tests hold the
 * line: SurveyFlow's own sender must not deliver somebody else's words (or links) to somebody else.
 */
describe('e-mail greetings', () => {
  it('keeps an ordinary name', () => {
    expect(greetingName('Jean-Luc')).toBe('Jean-Luc');
    expect(greetingName("Aïcha N'Diaye")).toBe("Aïcha N'Diaye");
    expect(greetingName('  Marie  ')).toBe('Marie');
  });

  it('drops anything that could be a link, an address or a second line', () => {
    for (const bad of ['Win now http://evil.example', 'https://evil.example', 'evil.example/claim', 'a@b.c', 'www.evil.example', 'x\\y', 'Click: here', '\n\nhttps://evil.example', '<b>hi</b>x:y']) {
      expect(greetingName(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(greetingName('Bob\nCongratulations, you won')).toBe('Bob'); // only the first line
    expect(greetingName('x'.repeat(100))).toHaveLength(40);
    expect(greetingName('')).toBeUndefined();
    expect(greetingName(undefined)).toBeUndefined();
  });

  it('the confirmation e-mail never greets by name, in either language, and carries none of the typed text', () => {
    for (const lang of ['en', 'fr'] as const) {
      const m = renderMail('verify_email', lang, { url: 'https://app.example/verify-email?token=t', name: 'Dear friend, claim your prize' });
      expect(m.text.split('\n')[0]).toBe(lang === 'fr' ? 'Bonjour,' : 'Hello,');
      expect(m.text).not.toContain('prize');
      expect(m.html).not.toContain('prize');
    }
  });

  it('other e-mails greet an owner by a safe name, and by nothing when the name is not safe', () => {
    expect(renderMail('new_device', 'en', { name: 'Jean-Luc', place: 'Chrome', when: 'now' }).text.startsWith('Hello Jean-Luc,')).toBe(true);
    const hostile = renderMail('password_changed', 'en', { name: 'Bob http://evil.example', when: 'now' });
    expect(hostile.text.startsWith('Hello,')).toBe(true);
    expect(hostile.text + hostile.html).not.toContain('evil.example');
  });
});
