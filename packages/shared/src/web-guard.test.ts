import { describe, expect, it } from 'vitest';
import { PROXY_MAX_SEGMENTS, proxyVerdict, safeRelativePath } from './web-guard';

const seg = (path: string) => path.split('/');

describe('the API proxy: which calls a browser may make', () => {
  it('ordinary calls need the session cookie', () => {
    for (const p of ['surveys', 'surveys/ckx1abc/export/excel', 'contacts/ckx1abc/reveal', 'surveys/ckx1abc/not-started.csv', 'auth/me', 'auth/sessions/revoke-all', 'auth/step-up/email-code']) {
      expect(proxyVerdict(seg(p)), p).toBe('session');
    }
  });

  it('the sign-up and e-mail-link flows work without a session', () => {
    for (const p of ['auth/register', 'auth/config', 'auth/verify-email', 'auth/verify-email/resend', 'auth/password/forgot', 'auth/password/reset', 'auth/google/link/confirm', 'dev/mailbox']) {
      expect(proxyVerdict(seg(p)), p).toBe('public');
    }
  });

  it('signing in, renewing, signing out and the webhooks are never reachable from a browser', () => {
    for (const p of ['auth/login', 'auth/refresh', 'auth/google', 'auth/signout', 'auth/logout', 'webhook/whatsapp', 'payments/webhook/notchpay', 'payments/webhook/campay']) {
      expect(proxyVerdict(seg(p)), p).toBe('never');
    }
    // however the case is spelled: the list must not depend on how the API's router treats it
    for (const p of ['Auth/Login', 'AUTH/REFRESH', 'auth/Google', 'Webhook/whatsapp', 'payments/WEBHOOK/notchpay']) expect(proxyVerdict(seg(p)), p).toBe('never');
  });

  it('refuses every way of smuggling a different route through a decoded piece (each one reached /api/auth/login before the fix)', () => {
    const hostile: string[][] = [
      ['auth', 'login?x=1'], // %3F
      ['auth', 'refresh#x'], // %23
      ['auth/login'], // %2F
      ['contacts/../auth/login'], // %2F..%2F
      ['contacts', '..%2Fauth', 'login'],
      ['..', 'auth', 'login'], ['.', 'auth', 'login'], ['auth', '..'], ['auth', '.'],
      ['auth', '%2e%2e'], ['auth', 'login%00'], ['auth', 'login\u0000'], ['auth', 'login\n'], ['auth', 'login '], ['auth', 'lo gin'],
      ['auth', 'login\\'], ['a\\b'], ['auth', 'login;x'], ['auth', 'login:80'], ['auth', 'login@host'], ['auth', 'lögin'],
      ['webhook?', 'whatsapp'], ['payments', 'webhook?x'], [''], ['auth', ''],
      ['x'.repeat(201)],
      Array.from({ length: PROXY_MAX_SEGMENTS + 1 }, () => 'a'),
    ];
    for (const h of hostile) expect(proxyVerdict(h), JSON.stringify(h)).toBe('bad_request');
    expect(proxyVerdict([])).toBe('bad_request');
    expect(proxyVerdict(undefined)).toBe('bad_request');
  });

  it('what is accepted is only letters, digits, dot, dash, underscore and tilde, so putting the pieces back into a URL can never change its shape', () => {
    for (const verdict of [proxyVerdict(seg('surveys/ckx1abc.def_ghi-1~2/export')), proxyVerdict(seg('receipts/abc.DEF_123-x'))]) expect(verdict).toBe('session');
    const base = 'http://api.internal';
    for (const p of ['surveys/ckx1abc/export/excel', 'surveys/a.b/not-started.csv']) {
      expect(new URL(`/api/${seg(p).map(encodeURIComponent).join('/')}`, base).pathname).toBe(`/api/${p}`);
    }
  });
});

describe('where to go after signing in', () => {
  it('keeps a path on this site, with its query and fragment', () => {
    for (const ok of ['/', '/dashboard', '/surveys/ckx1abc?tab=2#top', '/settings?tab=security', '/%5Cevil.example']) expect(safeRelativePath(ok), ok).toBe(ok);
  });

  it('never leaves the site (an open redirect after sign-in is a phishing aid)', () => {
    const hostile = [
      '//evil.example', '///evil.example', '/\\evil.example', '/\\/evil.example', '/\t/evil.example', '/\n/evil.example', '/ /evil.example', '/\u0000/evil.example',
      'https://evil.example', 'http://evil.example/x', 'javascript:alert(1)', 'data:text/html,x', 'evil.example', '\\\\evil.example', '/a\\b', '', 'dashboard',
      `/${'a'.repeat(1001)}`,
    ];
    for (const h of hostile) {
      expect(safeRelativePath(h), JSON.stringify(h)).toBe('/dashboard');
      // and what a browser would actually do with the answer stays on the origin
      expect(new URL(safeRelativePath(h), 'https://app.example').origin).toBe('https://app.example');
    }
    expect(safeRelativePath(null)).toBe('/dashboard');
    expect(safeRelativePath(undefined)).toBe('/dashboard');
    expect(safeRelativePath('//evil.example', '/onboarding')).toBe('/onboarding');
  });
});
