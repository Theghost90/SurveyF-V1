import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { redis } from '../src/lib/redis';
import { mailIdle, readMockMailbox, sendMail, sendMailInBackground } from '../src/services/mail';

/**
 * The three real e-mail providers, run for the first time against stand-ins for them: a small SMTP server on this machine for `smtp`, and a replaced `fetch` for
 * `resend` and `brevo` (their addresses are fixed in the code). What this proves: the messages are well formed, reach the right place with the right credentials
 * and a failure never throws into a sign-up. What it cannot prove: that the real services accept them (docs/SECURITY.md §16).
 */
const saved = { provider: env.emailProvider, from: env.EMAIL_FROM, smtp: env.SMTP_URL, resend: env.RESEND_API_KEY, brevo: env.BREVO_API_KEY };
afterEach(() => {
  Object.assign(env, { emailProvider: saved.provider, EMAIL_FROM: saved.from, SMTP_URL: saved.smtp, RESEND_API_KEY: saved.resend, BREVO_API_KEY: saved.brevo });
  vi.unstubAllGlobals();
});
afterAll(() => { redis.disconnect(); });

const warnings: unknown[] = [];
const log = { warn: (o: unknown) => { warnings.push(o); } };
const params = { url: 'https://app.example/verify-email?token=abc', name: 'Awa' };

/** A tiny SMTP server: no TLS, no authentication, remembers what it was given. */
function smtpServer(opts: { refuse?: boolean } = {}) {
  const received: Array<{ from?: string; to: string[]; data: string }> = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let current: { from?: string; to: string[]; data: string } = { to: [], data: '' };
    let inData = false;
    let buf = '';
    sock.write('220 test.local ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          received.push(current);
          current = { to: [], data: '' };
          sock.write('250 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-test.local\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') { current.from = /<([^>]*)>/.exec(line)?.[1]; sock.write(opts.refuse ? '550 sender refused\r\n' : '250 ok\r\n'); }
        else if (cmd === 'RCPT') { current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  return {
    received,
    start: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))),
    stop: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

describe('smtp', () => {
  const smtp = smtpServer();
  let port = 0;
  beforeAll(async () => { port = await smtp.start(); });
  afterAll(async () => { await smtp.stop(); });

  it('hands a well-formed message to the server: sender, one recipient, subject, a text part with the link and an HTML part', async () => {
    Object.assign(env, { emailProvider: 'smtp', SMTP_URL: `smtp://127.0.0.1:${port}`, EMAIL_FROM: 'SurveyFlow <no-reply@surveyflow.test>' });
    const ok = await sendMail('owner@example.com', 'verify_email', 'en', params, log);
    expect(ok).toBe(true);
    expect(smtp.received).toHaveLength(1);
    const m = smtp.received[0]!;
    expect(m.from).toBe('no-reply@surveyflow.test');
    expect(m.to).toEqual(['owner@example.com']);
    expect(m.data).toMatch(/^Subject: Confirm your SurveyFlow e-mail address$/m);
    expect(m.data).toMatch(/^From: SurveyFlow <no-reply@surveyflow\.test>$/m);
    expect(m.data).toMatch(/^To: owner@example\.com$/m);
    expect(m.data).toContain('Content-Type: text/plain');
    expect(m.data).toContain('Content-Type: text/html');
    // the link survives (the text part is quoted-printable: soft line breaks and =XX escapes are undone before looking)
    const decoded = m.data.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    expect(decoded).toContain('https://app.example/verify-email?token=abc');
    expect(decoded).not.toContain('Awa'); // the confirmation e-mail never greets by a typed name
  });

  it('a recipient that cannot be reached is reported as false after a second try, never thrown', async () => {
    const refusing = smtpServer({ refuse: true });
    const p = await refusing.start();
    try {
      // the transport is created once per process (it is cached), so a refused send is shown through a fresh module instance (with its own copy of the settings)
      vi.resetModules();
      Object.assign((await import('../src/config/env')).env, { emailProvider: 'smtp', SMTP_URL: `smtp://127.0.0.1:${p}` });
      const fresh = await import('../src/services/mail');
      warnings.length = 0;
      expect(await fresh.sendMail('owner@example.com', 'verify_email', 'en', params, log)).toBe(false);
      expect(warnings.length).toBe(1);
      expect(JSON.stringify(warnings[0])).not.toContain('token=abc'); // the failure is logged without the message
    } finally { await refusing.stop(); }
  });
});

describe('resend', () => {
  it('posts to the Resend API with the key as a bearer token and the message as JSON', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"id":"x"}', { status: 200 }); }));
    Object.assign(env, { emailProvider: 'resend', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'SurveyFlow <no-reply@surveyflow.test>' });
    expect(await sendMail('owner@example.com', 'reset_password', 'fr', { url: 'https://app.example/reset-password?token=t', name: 'Awa' }, log)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ from: 'SurveyFlow <no-reply@surveyflow.test>', to: ['owner@example.com'] });
    expect(body.subject).toMatch(/mot de passe/i);
    expect(body.text).toContain('https://app.example/reset-password?token=t');
    expect(body.html).toContain('<a href=');
  });

  it('a refusal from the provider is tried twice and reported as false', async () => {
    const f = vi.fn(async () => new Response('{"message":"invalid"}', { status: 422 }));
    vi.stubGlobal('fetch', f);
    Object.assign(env, { emailProvider: 'resend', RESEND_API_KEY: 're_test_key' });
    warnings.length = 0;
    expect(await sendMail('owner@example.com', 'verify_email', 'en', params, log)).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(1);
  });
});

describe('brevo', () => {
  it('posts to the Brevo API with the key in the api-key header, the sender split into name and address', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"messageId":"x"}', { status: 201 }); }));
    Object.assign(env, { emailProvider: 'brevo', BREVO_API_KEY: 'xkeysib-test', EMAIL_FROM: '"SurveyFlow Team" <no-reply@surveyflow.test>' });
    expect(await sendMail('owner@example.com', 'verify_email', 'en', params, log)).toBe(true);
    expect(calls[0]!.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((calls[0]!.init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.sender).toEqual({ name: 'SurveyFlow Team', email: 'no-reply@surveyflow.test' });
    expect(body.to).toEqual([{ email: 'owner@example.com' }]);
    expect(body.textContent).toContain('https://app.example/verify-email?token=abc');
    expect(body.htmlContent).toContain('<a href=');
  });
});

describe('background sending', () => {
  it('returns at once, and the mock mailbox waits for what is still in flight', async () => {
    Object.assign(env, { emailProvider: 'mock' });
    await redis.del('sf:mailbox:later-bg@example.com');
    const started = Date.now();
    sendMailInBackground('later-bg@example.com', 'verify_email', 'en', params);
    expect(Date.now() - started).toBeLessThan(50);
    const box = await readMockMailbox('later-bg@example.com'); // waits for the send
    expect(box).toHaveLength(1);
    await mailIdle();
  });

  it('never throws into the caller, even when the provider is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    Object.assign(env, { emailProvider: 'resend', RESEND_API_KEY: 'k' });
    expect(() => sendMailInBackground('owner@example.com', 'verify_email', 'en', params)).not.toThrow();
    await expect(mailIdle()).resolves.toBeUndefined();
  });
});
