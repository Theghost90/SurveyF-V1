import { env } from '../../config/env';

/**
 * The e-mails SurveyFlow sends about an account. Text first (every mail client shows it), a plain HTML copy next to it.
 * They never contain participant data: counts, a survey title, a browser and a place, that is all. Anything typed by a person is HTML-escaped.
 */
export type Lang = 'en' | 'fr';

export type MailKind =
  | 'verify_email' | 'register_existing' | 'reset_password' | 'password_changed' | 'new_device' | 'failed_logins'
  | 'export_alert' | 'bulk_delete_alert' | 'bulk_read_alert' | 'sheets_sync_paused' | 'two_factor_changed' | 'sessions_revoked' | 'link_google' | 'step_up_code'
  | 'deletion_requested' | 'deletion_cancelled' | 'account_deleted' | 'template_recategorised' | 'payouts_held' | 'reconciliation_alert';

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
  /** template_recategorised: the template, what it was, what it is (or will be), and whether it already happened. */
  template?: string;
  from?: string;
  to?: string;
  soon?: boolean;
  /** reconciliation_alert: one line per finding. */
  items?: string[];
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
        ? { subject: 'Confirmez votre adresse e-mail SurveyFlow', lines: [hi, 'Confirmez que cette adresse est bien la vôtre pour activer votre compte SurveyFlow. Le lien est valable 24 heures.', ...(env.CONFIRM_REQUIRES_PASSWORD ? ['Il vous sera demandé le mot de passe choisi à l’inscription : c’est ce qui prouve que l’inscription était la vôtre.'] : [])], button: { label: 'Confirmer mon adresse', url: p.url! }, foot: 'Si vous n’avez pas créé de compte, ignorez ce message : rien ne sera activé.' }
        : { subject: 'Confirm your SurveyFlow e-mail address', lines: [hi, 'Confirm that this address is yours to activate your SurveyFlow account. The link is valid for 24 hours.', ...(env.CONFIRM_REQUIRES_PASSWORD ? ['You will be asked for the password you chose when you signed up: that is what proves the sign-up was yours.'] : [])], button: { label: 'Confirm my address', url: p.url! }, foot: 'If you did not create an account, ignore this message: nothing will be activated.' };
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
    case 'bulk_read_alert':
      return fr
        ? { subject: 'Beaucoup de participants consultés sur votre compte', lines: [hi, `Les noms et réponses de plus de ${p.count} participants ont été affichés en 24 heures depuis votre compte (dernier accès le ${p.when}, depuis ${p.place}).`, 'C’est bien vous ? On vous demandera de confirmer que c’est vous pour continuer : aucune autre action n’est nécessaire.', notYou] }
        : { subject: 'A lot of participants were viewed on your account', lines: [hi, `The names and answers of more than ${p.count} participants were shown within 24 hours from your account (latest on ${p.when}, from ${p.place}).`, 'Was it you? You will be asked to confirm it is you to carry on: nothing else to do.', notYou] };
    case 'sheets_sync_paused':
      return fr
        ? { subject: 'La synchronisation Google Sheets est en pause', lines: [hi, `La synchronisation automatique vers Google Sheets de « ${p.what} » est en pause : elle doit être confirmée de nouveau tous les ${p.count} jours. Les nouvelles réponses attendent, rien n’est perdu.`, `Pour reprendre : ouvrez l’export du sondage et confirmez : ${p.url ?? settingsUrl()}`], foot: 'Si vous ne reconnaissez pas cette synchronisation, déconnectez Google dans Paramètres, Intégrations.' }
        : { subject: 'Google Sheets sync is paused', lines: [hi, `The automatic Google Sheets sync of “${p.what}” is paused: it has to be confirmed again every ${p.count} days. New answers are waiting, nothing is lost.`, `To resume: open the survey's export page and confirm: ${p.url ?? settingsUrl()}`], foot: 'If you do not recognise this sync, disconnect Google in Settings, Integrations.' };
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
    case 'deletion_requested':
      return fr
        ? { subject: 'La suppression de votre compte SurveyFlow est programmée', lines: [hi, `Vous avez demandé la suppression de votre compte. Elle aura lieu le ${p.when}, soit dans ${p.count} jours : vos sondages, participants, réponses et réglages seront alors effacés. Seuls les justificatifs d’argent reçu ou versé sont conservés, sans nom ni numéro, comme la comptabilité l’exige.`, 'Vos sondages ont été mis en pause et vous avez été déconnecté des autres appareils. Vous pouvez annuler jusqu’à cette date en vous connectant : Paramètres, Mes données.', notYou] }
        : { subject: 'Your SurveyFlow account is scheduled for deletion', lines: [hi, `You asked for your account to be deleted. It will happen on ${p.when}, in ${p.count} days: your surveys, participants, answers and settings will then be erased. Only the records of money received or paid out are kept, without any name or number, as accounting rules require.`, 'Your surveys were paused and you were signed out of your other devices. You can cancel until then by signing in: Settings, Your data.', notYou] };
    case 'deletion_cancelled':
      return fr
        ? { subject: 'La suppression de votre compte est annulée', lines: [hi, 'La suppression de votre compte a été annulée. Rien n’a été effacé. Vos sondages restent en pause : reprenez-les quand vous voulez.', notYou] }
        : { subject: 'Your account deletion was cancelled', lines: [hi, 'The deletion of your account was cancelled. Nothing was erased. Your surveys stay paused: resume them whenever you like.', notYou] };
    case 'account_deleted':
      return fr
        ? { subject: 'Votre compte SurveyFlow a été supprimé', lines: [hi, 'Votre compte et les données qu’il contenait ont été effacés. Conservez ce message comme preuve : nous n’avons plus rien qui vous identifie, hormis les justificatifs financiers décrits dans notre politique de confidentialité.'] }
        : { subject: 'Your SurveyFlow account was deleted', lines: [hi, 'Your account and the data it held have been erased. Keep this message as your proof: we hold nothing that identifies you any more, apart from the financial records described in our privacy policy.'] };
    case 'template_recategorised': {
      const t = p.template ?? '';
      return fr
        ? { subject: p.soon ? 'Meta va changer la catégorie d’un de vos modèles WhatsApp' : 'Meta a changé la catégorie d’un de vos modèles WhatsApp', lines: [hi, p.soon
          ? `Meta a annoncé qu’elle va classer le modèle « ${t} » de votre compte WhatsApp en ${p.to}${p.when ? ` vers le ${p.when}` : ''}. Les messages envoyés avec ce modèle seront alors facturés au tarif ${p.to}, plus élevé que le tarif ${p.from}.`
          : `Meta a classé le modèle « ${t} » de votre compte WhatsApp en ${p.to} (il était ${p.from}). Les messages envoyés avec ce modèle sont facturés au tarif ${p.to}.`,
        'Ce que SurveyFlow fait : un sondage qui s’envoyait au tarif utilitaire est traité comme un sondage marketing, et on vous demandera d’accepter ce coût avant chaque envoi. Les invitations qui attendaient d’être envoyées avec l’ancien tarif sont retenues (statut « échec ») : renvoyez-les depuis la page du sondage quand vous acceptez le nouveau coût.', 'Les tarifs sont ceux de Meta, par pays : consultez la facturation de votre compte WhatsApp Business.'] }
        : { subject: p.soon ? 'Meta is about to change the category of one of your WhatsApp templates' : 'Meta changed the category of one of your WhatsApp templates', lines: [hi, p.soon
          ? `Meta announced that it will classify the template "${t}" of your WhatsApp account as ${p.to}${p.when ? ` around ${p.when}` : ''}. Messages sent with it will then be billed at the ${p.to} rate, which is higher than the ${p.from} rate.`
          : `Meta classified the template "${t}" of your WhatsApp account as ${p.to} (it was ${p.from}). Messages sent with it are billed at the ${p.to} rate.`,
        'What SurveyFlow does: a survey that was sent at the utility rate is now treated as a marketing survey, and you will be asked to accept that cost before each send. Invitations that were waiting to go out at the old rate are held back (status "failed"): send them again from the survey page once you accept the new cost.', 'The rates are Meta\'s, by country: see the billing of your WhatsApp Business account.'] };
    }
    case 'payouts_held': {
      const why: Record<string, [string, string]> = {
        young_account: ['votre compte a quelques jours seulement', 'your account is only a few days old'],
        account_daily_cap: ['votre compte a atteint sa limite quotidienne de versements', 'your account reached its daily payout limit'],
        phone_daily_cap: ['un numéro de téléphone a atteint sa limite quotidienne de cadeaux', 'a phone number reached its daily limit for gifts'],
        amount_above_cap: ['le montant d’un cadeau dépasse la limite : il ne partira pas tout seul, contactez le support', 'the amount of a gift is above the limit, so it will not be sent by itself: contact support'],
        fx_unavailable: ['le taux de change de la devise de votre porte-monnaie n’est pas disponible', 'the exchange rate for your wallet currency is not available'],
      };
      const [frWhy, enWhy] = why[p.what ?? ''] ?? ['une limite de sécurité', 'a safety limit'];
      return fr
        ? { subject: 'Des cadeaux attendent à cause d’une limite de sécurité', lines: [hi, `Certains cadeaux de participants n’ont pas encore été versés : ${frWhy}. Les participants ont reçu un simple remerciement. Les cadeaux partent automatiquement, du plus ancien au plus récent, dès que la limite le permet${p.when ? ` (vers le ${p.when})` : ''}, et les participants sont alors prévenus.`, 'Rien n’a été débité de votre porte-monnaie pour ces cadeaux. Ces limites protègent les porte-monnaie contre l’encaissement de cartes volées ; pour les faire changer, contactez le support.'] }
        : { subject: 'Some gifts are waiting because of a safety limit', lines: [hi, `Some gifts for participants were not paid out yet: ${enWhy}. The participants received a plain thank-you. The gifts are sent automatically, oldest first, as soon as the limit allows${p.when ? ` (about ${p.when})` : ''}, and the participants are then told.`, 'Nothing was debited from your wallet for these gifts. These limits protect wallets from stolen cards being cashed out; to have them changed, contact support.'] };
    }
    case 'reconciliation_alert': {
      const items = p.items ?? [];
      return fr
        ? { subject: `Rapprochement quotidien : ${items.length} point(s) à regarder`, lines: ['Le contrôle quotidien des porte-monnaie et des fonds chez les prestataires a trouvé :', ...items.map((i) => `• ${i}`), 'Rien n’a été modifié par ce contrôle. Détail : npx tsx --env-file=.env scripts/reconcile.mts status. Cette alerte n’est envoyée qu’une fois par jour et par point.'] }
        : { subject: `Daily reconciliation: ${items.length} item(s) to look at`, lines: ['The daily check of the wallets and of the funds at the payment providers found:', ...items.map((i) => `• ${i}`), 'This check changed nothing. Details: npx tsx --env-file=.env scripts/reconcile.mts status. This alert is sent once a day for each item.'] };
    }
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
