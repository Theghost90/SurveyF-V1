import { env } from '../../config/env';
import { redis } from '../../lib/redis';
import { renderMail, type Lang, type MailKind, type MailParams } from './templates';

export type { Lang, MailKind, MailParams } from './templates';

/**
 * Sends e-mail through the configured provider.
 *   mock    keeps the message in a local mailbox in Redis and sends NOTHING (development, tests, the shared demo). Read it at /api/dev/mailbox.
 *   smtp    any SMTP server (SMTP_URL)
 *   resend  Resend's HTTP API      brevo  Brevo's HTTP API
 * smtp, resend and brevo are written from each service's documentation and have not been exercised against the real service (docs/DECISIONS.md §4).
 * A message that cannot be sent never throws into the caller: the flows that matter answer the same way either way (so they reveal nothing), and
 * every one of them can be asked again.
 */
export interface SentMail { to: string; kind: MailKind; subject: string; text: string; html: string }

const parseFrom = (from: string): { name: string; email: string } => {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1]!.trim() || 'SurveyFlow', email: m[2]!.trim() } : { name: 'SurveyFlow', email: from.trim() };
};

async function viaHttp(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`mail provider answered ${res.status}`);
}

let smtpTransport: Promise<{ sendMail: (m: Record<string, unknown>) => Promise<unknown> }> | undefined;
const smtp = () => (smtpTransport ??= import('nodemailer').then((n) => n.createTransport(env.SMTP_URL!) as never));

async function deliver(m: SentMail): Promise<void> {
  const from = env.EMAIL_FROM;
  switch (env.emailProvider) {
    case 'mock': {
      const key = `sf:mailbox:${m.to.toLowerCase()}`;
      await redis.lpush(key, JSON.stringify({ at: new Date().toISOString(), kind: m.kind, subject: m.subject, text: m.text }));
      await redis.ltrim(key, 0, 19);
      await redis.expire(key, 2 * 3600);
      return;
    }
    case 'smtp':
      await (await smtp()).sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
      return;
    case 'resend':
      return viaHttp('https://api.resend.com/emails', {
        method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
    case 'brevo': {
      const f = parseFrom(from);
      return viaHttp('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { name: f.name, email: f.email }, to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html }),
      });
    }
  }
}

export interface Logger { warn: (o: unknown, m?: string) => void }

/** Returns whether the provider accepted the message. Never throws, never logs the message itself (it may hold a link that signs someone in). */
export async function sendMail(to: string, kind: MailKind, lang: Lang, params: MailParams = {}, log: Logger = console as never): Promise<boolean> {
  const { subject, text, html } = renderMail(kind, lang, params);
  const mail: SentMail = { to, kind, subject, text, html };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { await deliver(mail); return true; } catch (err) {
      if (attempt === 2) log.warn({ kind, provider: env.emailProvider, err: (err as Error).message }, 'e-mail could not be sent');
    }
  }
  return false;
}

const inFlight = new Set<Promise<unknown>>();

/**
 * Sends without making the caller wait. For the places where the answer must not depend on whether a message was sent (sign-up, "resend the link", "forgot my
 * password"): handing a message to a provider takes tens to hundreds of milliseconds, so waiting for it would tell a patient stranger which addresses are customers.
 * `mailIdle()` waits for everything in flight (the mock mailbox reader, so tests stay deterministic, and shutdown).
 */
export function sendMailInBackground(...args: Parameters<typeof sendMail>): void {
  const p: Promise<unknown> = sendMail(...args).catch(() => false).finally(() => inFlight.delete(p));
  inFlight.add(p);
}
export const mailIdle = async (): Promise<void> => { await Promise.allSettled([...inFlight]); };

/** The mock provider's mailbox for one address, newest first. Only meaningful (and only exposed) when EMAIL_PROVIDER=mock. */
export async function readMockMailbox(to: string): Promise<Array<{ at: string; kind: MailKind; subject: string; text: string; links: string[] }>> {
  await mailIdle();
  const raw = await redis.lrange(`sf:mailbox:${to.toLowerCase()}`, 0, 19);
  return raw.map((r) => {
    const m = JSON.parse(r) as { at: string; kind: MailKind; subject: string; text: string };
    return { ...m, links: [...m.text.matchAll(/https?:\/\/[^\s<>"]+/g)].map((x) => x[0]) };
  });
}
