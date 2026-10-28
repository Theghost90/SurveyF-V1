import { env } from '../../config/env';

/**
 * The e-mails SurveyFlow sends about an account. Text first (every mail client shows it), a plain HTML copy next to it.
 * They never contain participant data: counts, a survey title, a browser and a place, that is all. Anything typed by a person is HTML-escaped.
 */
export type Lang = 'en' | 'fr';

export type MailKind =
  | 'verify_email' | 'register_existing' | 'reset_password' | 'password_changed' | 'new_device' | 'failed_logins'
  | 'export_alert' | 'bulk_delete_alert' | 'two_factor_changed' | 'sessions_revoked' | 'link_google' | 'step_up_code';

export interface MailParams {
  url?: string;
  name?: string;
  code?: string;
  when?: string;
  place?: string; // "Chrome · Windows, 41.202.207.x (CM)"
  count?: number;
  rows?: number;
  what?: string; // export kind or survey title
  enabled?: boolean;
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A name somebody typed into a form, made safe to print in a greeting: one short line, and nothing that could be a link or an address. Anybody can type anything
 * into the sign-up form, and the e-mail goes to the address they typed, which may be a stranger's: without this, SurveyFlow's own sender would deliver their text.
 * Better no greeting by name than a clever one.
 */
export function greetingName(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const line = raw.split(/[\r\n]/)[0]!.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim();
  if (!line || /[:/@\\]|www\./i.test(line)) return undefined;
  return line.slice(0, 40);
}

const settingsUrl = () => `${env.webBaseUrl}/settings?tab=security`;
const forgotUrl = () => `${env.webBaseUrl}/forgot-password`;
const loginUrl = () => `${env.webBaseUrl}/login`;

interface Body { subject: string; lines: string[]; button?: { label: string; url: string }; foot?: string }

function build(kind: MailKind, lang: Lang, p: MailParams): Body {
  const fr = lang === 'fr';
  // The confirmation e-mail never greets by name: the name came from whoever filled in the sign-up form, and the address may not be theirs.
  const who = kind === 'verify_email' ? undefined : greetingName(p.name);
  const hi = who ? (fr ? `Bonjour ${who},` : `Hello ${who},`) : fr ? 'Bonjour,' : 'Hello,';
  const notYou = fr
    ? `Ce n’était pas vous ? Changez votre mot de passe et déconnectez tous vos appareils : ${settingsUrl()}`
    : `Wasn’t you? Change your password and sign out everywhere: ${settingsUrl()}`;
  switch (kind) {
    case 'verify_email':
      return fr
        ? { subject: 'Confirmez votre adresse e-mail SurveyFlow', lines: [hi, 'Confirmez que cette adresse est bien la vôtre pour activer votre compte SurveyFlow. Le lien est valable 24 heures.'], button: { label: 'Confirmer mon adresse', url: p.url! }, foot: 'Si vous n’avez pas créé de compte, ignorez ce message : rien ne sera activé.' }
        : { subject: 'Confirm your SurveyFlow e-mail address', lines: [hi, 'Confirm that this address is yours to activate your SurveyFlow account. The link is valid for 24 hours.'], button: { label: 'Confirm my address', url: p.url! }, foot: 'If you did not create an account, ignore this message: nothing will be activated.' };
    case 'register_existing':
      return fr
        ? { subject: 'Vous avez déjà un compte SurveyFlow', lines: [hi, 'Quelqu’un (peut-être vous) a essayé de créer un compte avec cette adresse, mais elle en a déjà un.', `Connectez-vous : ${loginUrl()}`, `Mot de passe oublié ? ${forgotUrl()}`], foot: 'Si ce n’était pas vous, vous n’avez rien à faire : votre compte n’a pas été modifié.' }
        : { subject: 'You already have a SurveyFlow account', lines: [hi, 'Someone (maybe you) tried to create an account with this address, but it already has one.', `Sign in: ${loginUrl()}`, `Forgot your password? ${forgotUrl()}`], foot: 'If it was not you there is nothing to do: your account was not changed.' };
    case 'reset_password':
      return fr
        ? { subject: 'Réinitialisez votre mot de passe SurveyFlow', lines: [hi, 'Vous avez demandé à réinitialiser votre mot de passe. Le lien est valable 30 minutes et ne sert qu’une fois.'], button: { label: 'Choisir un nouveau mot de passe', url: p.url! }, foot: 'Si vous n’avez rien demandé, ignorez ce message : votre mot de passe reste inchangé.' }
        : { subject: 'Reset your SurveyFlow password', lines: [hi, 'You asked to reset your password. The link is valid for 30 minutes and works once.'], button: { label: 'Choose a new password', url: p.url! }, foot: 'If you did not ask for this, ignore this message: your password stays as it is.' };
    case 'password_changed':
      return fr
        ? { subject: 'Votre mot de passe SurveyFlow a été modifié', lines: [hi, `Le mot de passe de votre compte a été modifié le ${p.when}. Tous les autres appareils ont été déconnectés.`, notYou] }
        : { subject: 'Your SurveyFlow password was changed', lines: [hi, `Your account password was changed on ${p.when}. Every other device was signed out.`, notYou] };
    case 'new_device':
      return fr
        ? { subject: 'Nouvelle connexion à votre compte SurveyFlow', lines: [hi, `Connexion depuis ${p.place} le ${p.when}.`, 'C’est bien vous ? Aucune action n’est nécessaire.', notYou] }
        : { subject: 'New sign-in to your SurveyFlow account', lines: [hi, `Sign-in from ${p.place} on ${p.when}.`, 'Was it you? Nothing to do.', notYou] };
    case 'failed_logins':
      return fr
        ? { subject: 'Tentatives de connexion échouées sur votre compte', lines: [hi, `${p.count} tentatives de connexion avec un mauvais mot de passe ont visé votre compte récemment. Elles ont été ralenties et ne sont pas passées.`, `Si ce n’était pas vous, choisissez un mot de passe plus solide : ${settingsUrl()}`] }
        : { subject: 'Failed sign-in attempts on your account', lines: [hi, `${p.count} sign-in attempts with a wrong password targeted your account recently. They were slowed down and did not get in.`, `If it was not you, choose a stronger password: ${settingsUrl()}`] };
    case 'export_alert':
      return fr
        ? { subject: 'Des données de participants ont été téléchargées', lines: [hi, `Un fichier de ${p.rows} lignes (${p.what}) a été téléchargé depuis votre compte le ${p.when}, depuis ${p.place}.`, notYou] }
        : { subject: 'Participant data was downloaded', lines: [hi, `A file of ${p.rows} rows (${p.what}) was downloaded from your account on ${p.when}, from ${p.place}.`, notYou] };
    case 'bulk_delete_alert':
      return fr
        ? { subject: 'Des contacts ont été supprimés en masse', lines: [hi, `${p.rows} contacts ont été supprimés de votre compte le ${p.when}, depuis ${p.place}.`, notYou] }
        : { subject: 'Contacts were deleted in bulk', lines: [hi, `${p.rows} contacts were deleted from your account on ${p.when}, from ${p.place}.`, notYou] };
    case 'two_factor_changed':
      return p.enabled
        ? (fr ? { subject: 'Double authentification activée', lines: [hi, `La double authentification a été activée sur votre compte le ${p.when}.`, notYou] }
            : { subject: 'Two-factor authentication turned on', lines: [hi, `Two-factor authentication was turned on for your account on ${p.when}.`, notYou] })
        : (fr ? { subject: 'Double authentification désactivée', lines: [hi, `La double authentification a été désactivée sur votre compte le ${p.when}.`, notYou] }
            : { subject: 'Two-factor authentication turned off', lines: [hi, `Two-factor authentication was turned off for your account on ${p.when}.`, notYou] });
    case 'sessions_revoked':
      return fr
        ? { subject: 'Vous avez été déconnecté de tous vos appareils', lines: [hi, `Toutes les sessions de votre compte ont été fermées le ${p.when}.`, notYou] }
        : { subject: 'You were signed out of every device', lines: [hi, `Every session of your account was closed on ${p.when}.`, notYou] };
    case 'link_google':
      return fr
        ? { subject: 'Confirmez la liaison de votre compte Google', lines: [hi, 'Un compte Google avec cette adresse veut se connecter à votre compte SurveyFlow existant. Confirmez pour les lier. Le lien est valable 30 minutes.'], button: { label: 'Lier mon compte Google', url: p.url! }, foot: 'Si ce n’était pas vous, ignorez ce message : rien ne sera lié.' }
        : { subject: 'Confirm linking your Google account', lines: [hi, 'A Google account with this address wants to sign in to your existing SurveyFlow account. Confirm to link them. The link is valid for 30 minutes.'], button: { label: 'Link my Google account', url: p.url! }, foot: 'If it was not you, ignore this message: nothing will be linked.' };
    case 'step_up_code':
      return fr
        ? { subject: `Votre code de confirmation SurveyFlow : ${p.code}`, lines: [hi, `Votre code de confirmation est ${p.code}. Il est valable 10 minutes.`], foot: 'Ne le communiquez à personne. SurveyFlow ne vous le demandera jamais par téléphone ou message.' }
        : { subject: `Your SurveyFlow confirmation code: ${p.code}`, lines: [hi, `Your confirmation code is ${p.code}. It is valid for 10 minutes.`], foot: 'Do not share it with anyone. SurveyFlow will never ask for it by phone or message.' };
  }
}

export function renderMail(kind: MailKind, lang: Lang, params: MailParams): { subject: string; text: string; html: string } {
  const b = build(kind, lang, params);
  const text = [...b.lines, ...(b.button ? [`${b.button.label}: ${b.button.url}`] : []), ...(b.foot ? ['', b.foot] : []), '', '— SurveyFlow'].join('\n\n').replace(/\n\n\n\n/g, '\n\n');
  const para = (l: string) => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0B6B4D">$1</a>')}</p>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#F6F3EC;font-family:Arial,Helvetica,sans-serif;color:#0B2B22"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">${
    b.lines.map(para).join('')
  }${b.button ? `<p style="margin:22px 0"><a href="${escapeHtml(b.button.url)}" style="display:inline-block;background:#4ADE80;color:#0B2B22;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:12px">${escapeHtml(b.button.label)}</a></p><p style="margin:0 0 14px;font-size:13px;color:#5A6B63;word-break:break-all">${escapeHtml(b.button.url)}</p>` : ''}${
    b.foot ? `<p style="margin:18px 0 0;font-size:13px;color:#5A6B63;line-height:1.5">${escapeHtml(b.foot)}</p>` : ''}<p style="margin:22px 0 0;font-size:13px;color:#5A6B63">SurveyFlow</p></div></body></html>`;
  return { subject: b.subject, text, html };
}
