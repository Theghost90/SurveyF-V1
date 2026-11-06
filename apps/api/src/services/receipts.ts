import { createHmac, timingSafeEqual } from 'node:crypto';
import { PAID_GIFT_TYPES, currencyLabel, isCfa, maskPhone } from '@surveyflow/shared';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { htmlToPdf } from './exports/pdf';

/**
 * Proof of gift. A receipt exists ONLY for a gift that was actually delivered (status `sent`): the link is minted at the moment
 * delivery succeeds, and the endpoint itself refuses anything else, so a failed / refunded / unfunded gift can never be "proved".
 *
 * The link is a capability URL: `<giftId>.<HMAC>`. It needs no login (the participant has none) and cannot be guessed or
 * enumerated. The receipt shows what the participant received, never what the owner paid (no fee, no wallet details).
 */

const sign = (giftId: string) => createHmac('sha256', env.jwtSecret).update(`receipt:${giftId}`).digest('base64url').slice(0, 22);

export const receiptToken = (giftId: string) => `${giftId}.${sign(giftId)}`;
export const receiptUrl = (giftId: string) => `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/receipts/${receiptToken(giftId)}`;

export function giftIdFromToken(token: string): string | null {
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const id = token.slice(0, i);
  const given = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(sign(id));
  return given.length === want.length && timingSafeEqual(given, want) ? id : null;
}

const L = {
  en: { title: 'Proof of gift', delivered: 'Delivered', from: 'From', survey: 'Survey', gift: 'Gift', amount: 'Amount', value: 'Value delivered', to: 'Sent to', date: 'Delivered on', ref: 'Reference', no: 'Receipt no.', note: 'This document confirms that the gift above was delivered to the phone number shown. It is not a tax invoice.', issued: 'Issued by SurveyFlow on behalf of' },
  fr: { title: 'Preuve de cadeau', delivered: 'Livré', from: 'De la part de', survey: 'Sondage', gift: 'Cadeau', amount: 'Montant', value: 'Valeur remise', to: 'Envoyé au', date: 'Livré le', ref: 'Référence', no: 'Reçu n°', note: 'Ce document confirme que le cadeau ci-dessus a été livré au numéro indiqué. Ce n’est pas une facture.', issued: 'Émis par SurveyFlow pour le compte de' },
} as const;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface ReceiptData {
  number: string; business: string; survey: string; gift: string; amount: number; currency: string; /** CFA francs actually delivered when the owner's currency is not FCFA */ deliveredXAF: number | null; phone: string; deliveredAt: Date; reference: string; lang: 'en' | 'fr';
}

/** Null unless this gift really was delivered. */
export async function loadReceipt(giftId: string): Promise<ReceiptData | null> {
  const g = await prisma.giftDelivery.findUnique({
    where: { id: giftId },
    include: { contact: { select: { phone: true } }, survey: { select: { title: true, language: true, user: { select: { businessName: true } } } } },
  });
  if (!g || g.status !== 'sent' || !g.sentAt || !g.amount || !(PAID_GIFT_TYPES as readonly string[]).includes(g.giftType)) return null;
  return {
    number: `SF-${g.id.slice(-8).toUpperCase()}`, business: g.survey.user.businessName, survey: g.survey.title, gift: g.giftValue ?? '', amount: g.amount, currency: g.currency, deliveredXAF: isCfa(g.currency) ? null : g.payoutXAF,
    phone: maskPhone(g.contact.phone), deliveredAt: g.sentAt, reference: g.providerRef ?? g.id, lang: g.survey.language === 'en' ? 'en' : 'fr',
  };
}

export function buildReceiptHtml(r: ReceiptData): string {
  const t = L[r.lang];
  const date = new Intl.DateTimeFormat(r.lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Africa/Douala' }).format(r.deliveredAt);
  const fmt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, r.lang === 'fr' ? ' ' : ',');
  const amount = `${fmt(r.amount)} ${currencyLabel(r.currency)}`;
  const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  return `<!doctype html><html lang="${r.lang}"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#0B2B22;margin:0}
.head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #2BD46E;padding-bottom:10px}
.brand{font-weight:800;font-size:18px}.no{font-size:11px;color:#5b6f66}
h1{font-size:22px;margin:18px 0 4px}.ok{display:inline-block;background:#DDEFE3;color:#0F7A40;font-weight:700;font-size:12px;padding:3px 10px;border-radius:99px}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th{width:34%;text-align:left;color:#5b6f66;font-weight:600;padding:7px 0;border-bottom:1px solid #e3ebe6;vertical-align:top}
td{padding:7px 0;border-bottom:1px solid #e3ebe6;font-weight:600;word-break:break-word}.amt td{font-size:18px}
.note{margin-top:20px;font-size:10.5px;color:#5b6f66;line-height:1.5}
</style></head><body>
<div class="head"><span class="brand">SurveyFlow</span><span class="no">${esc(t.no)} ${esc(r.number)}</span></div>
<h1>${esc(t.title)}</h1><span class="ok">&#10003; ${esc(t.delivered)}</span>
<table>
${row(t.from, r.business)}${row(t.survey, r.survey)}${row(t.gift, r.gift)}
<tr class="amt"><th>${esc(t.amount)}</th><td>${esc(amount)}</td></tr>${r.deliveredXAF ? row(t.value, `${fmt(r.deliveredXAF)} FCFA`) : ''}
${row(t.to, r.phone)}${row(t.date, date)}${row(t.ref, r.reference)}
</table>
<p class="note">${esc(t.note)}<br>${esc(t.issued)} ${esc(r.business)}.</p>
</body></html>`;
}

export async function buildReceiptPdf(token: string): Promise<{ pdf: Buffer; filename: string } | null> {
  const id = giftIdFromToken(token);
  if (!id) return null;
  const data = await loadReceipt(id);
  if (!data) return null;
  return { pdf: await htmlToPdf(buildReceiptHtml(data)), filename: `receipt-${data.number}.pdf` };
}
