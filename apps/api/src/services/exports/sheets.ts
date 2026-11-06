import { env } from '../../config/env';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { AppError, badRequest, conflict } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { redis } from '../../lib/redis';
import { audit } from '../audit';
import { displayAnswer } from '../analytics';
import { sendMailInBackground } from '../mail';

/**
 * Google Sheets API v4 over plain REST (no heavy SDK).
 * OAuth2: user consents once → we keep an encrypted refresh token → create a spreadsheet →
 * append one row per COMPLETED participant, in real time when auto-sync is on.
 *
 * Rows are written with valueInputOption=RAW so participant free text such as
 * "=IMPORTXML(...)" is stored as literal text and can never execute as a formula.
 */

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'openid', 'email'];

export const googleConfigured = () => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);

export function buildAuthUrl(state: string): string {
  if (!googleConfigured()) throw badRequest('google_not_configured', 'Google integration is not configured on this server');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
  u.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI!);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent'); // forces a refresh_token even on re-consent
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new AppError(502, 'google_token_error', json.error_description ?? json.error ?? 'Google rejected the request');
  return json;
}

export async function connectGoogle(userId: string, code: string) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: env.GOOGLE_REDIRECT_URI! });
  if (!t.refresh_token) throw badRequest('no_refresh_token', 'Google did not return offline access. Remove SurveyFlow from your Google account permissions and try again.');
  let email: string | null = null;
  try {
    // The id_token came straight from Google over TLS in exchange for our code, so decoding is safe here.
    email = (JSON.parse(Buffer.from(t.id_token!.split('.')[1]!, 'base64url').toString()) as { email?: string }).email ?? null;
  } catch { /* email is cosmetic */ }
  await prisma.googleConnection.upsert({
    where: { userId },
    create: { userId, email, refreshToken: encryptSecret(t.refresh_token), scope: t.scope },
    update: { email, refreshToken: encryptSecret(t.refresh_token), scope: t.scope },
  });
  return { email };
}

async function accessToken(userId: string): Promise<string> {
  const cached = await redis.get(`sf:gtoken:${userId}`);
  if (cached) return cached;
  const conn = await prisma.googleConnection.findUnique({ where: { userId } });
  if (!conn) throw conflict('google_not_connected', 'Connect your Google account first');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decryptSecret(conn.refreshToken) });
    await redis.set(`sf:gtoken:${userId}`, t.access_token!, 'EX', Math.max(60, (t.expires_in ?? 3600) - 120));
    return t.access_token!;
  } catch (err) {
    if (err instanceof AppError && err.code === 'google_token_error') {
      throw conflict('google_reauth_required', 'Google access was revoked or expired. Reconnect your Google account.');
    }
    throw err;
  }
}

async function sheetsApi<T>(userId: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`https://sheets.googleapis.com/v4/${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${await accessToken(userId)}`, 'Content-Type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (!res.ok) {
    if (res.status === 401) await redis.del(`sf:gtoken:${userId}`);
    throw new AppError(res.status === 404 ? 409 : 502, 'google_sheets_error', json.error?.message ?? `Google Sheets error ${res.status}`);
  }
  return json;
}

// ---- survey sync ---------------------------------------------------------------------------------

async function surveyForSync(surveyId: string, userId: string) {
  const survey = await prisma.survey.findFirst({ where: { id: surveyId, userId }, include: { questions: { orderBy: { order: 'asc' } } } });
  if (!survey) throw badRequest('not_found', 'Survey not found');
  return survey;
}

async function rowsFor(survey: Awaited<ReturnType<typeof surveyForSync>>, contactIds: string[]) {
  const recipients = await prisma.surveyRecipient.findMany({ where: { surveyId: survey.id, contactId: { in: contactIds }, status: 'completed' }, include: { contact: true }, orderBy: { completedAt: 'asc' } });
  const responses = await prisma.response.findMany({ where: { surveyId: survey.id, contactId: { in: contactIds } } });
  const byContact = new Map<string, Map<string, string>>();
  for (const r of responses) {
    const m = byContact.get(r.contactId) ?? new Map();
    m.set(r.questionId, r.answer);
    byContact.set(r.contactId, m);
  }
  return recipients.map((r) => ({
    contactId: r.contactId,
    values: [r.contact.name, r.contact.phone, r.completedAt?.toISOString() ?? '', ...survey.questions.map((q) => displayAnswer(q.type, byContact.get(r.contactId)?.get(q.id)))],
  }));
}

async function appendRows(userId: string, spreadsheetId: string, values: string[][]) {
  if (!values.length) return;
  await sheetsApi(userId, `spreadsheets/${spreadsheetId}/values/Responses!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: { values } });
}

/** SEC-20: auto-sync keeps copying new rows (names, numbers, answers) out of the account, so it lasts SHEETS_AUTOSYNC_DAYS after each confirmation and then pauses. */
const confirmedNow = (autoSync: boolean) => (autoSync ? { autoSyncConfirmedAt: new Date(), autoSyncPausedAt: null } : {});
export const autoSyncActive = (s: { autoSync: boolean; autoSyncConfirmedAt: Date | null }): boolean =>
  s.autoSync && !!s.autoSyncConfirmedAt && s.autoSyncConfirmedAt.getTime() > Date.now() - env.SHEETS_AUTOSYNC_DAYS * 86_400_000;
export const autoSyncConfirmedUntil = (s: { autoSync: boolean; autoSyncConfirmedAt: Date | null }): Date | null =>
  s.autoSync && s.autoSyncConfirmedAt ? new Date(s.autoSyncConfirmedAt.getTime() + env.SHEETS_AUTOSYNC_DAYS * 86_400_000) : null;

/** Creates the spreadsheet on first use, then appends every completed participant not yet written. */
export async function syncSurveyToSheets(userId: string, surveyId: string, requested?: boolean) {
  const survey = await surveyForSync(surveyId, userId);
  let sync = await prisma.sheetSync.findUnique({ where: { surveyId } });
  const confirm = requested === true; // asking for auto-sync is the owner confirming it (the caller has already required "confirm it is you")
  const autoSync = requested ?? sync?.autoSync ?? false; // absent: a one-off sync that leaves the setting alone

  if (!sync) {
    const created = await sheetsApi<{ spreadsheetId: string; spreadsheetUrl: string }>(userId, 'spreadsheets', {
      method: 'POST',
      body: { properties: { title: `SurveyFlow — ${survey.title}` }, sheets: [{ properties: { title: 'Responses', gridProperties: { frozenRowCount: 1 } } }] },
    });
    await appendRows(userId, created.spreadsheetId, [['Name', 'Phone', 'Completed at (UTC)', ...survey.questions.map((q, i) => `Q${i + 1}. ${q.text}`)]]);
    sync = await prisma.sheetSync.create({ data: { surveyId, userId, spreadsheetId: created.spreadsheetId, spreadsheetUrl: created.spreadsheetUrl, autoSync, ...confirmedNow(confirm) } });
  } else if (sync.autoSync !== autoSync || confirm) {
    // confirming again: the window starts over and a pause ends
    sync = await prisma.sheetSync.update({ where: { id: sync.id }, data: { autoSync, ...confirmedNow(confirm) } });
  }

  const done = new Set((await prisma.sheetRow.findMany({ where: { surveyId }, select: { contactId: true } })).map((r) => r.contactId));
  const pending = (await prisma.surveyRecipient.findMany({ where: { surveyId, status: 'completed' }, select: { contactId: true } })).map((r) => r.contactId).filter((id) => !done.has(id));
  const rows = await rowsFor(survey, pending);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await appendRows(userId, sync.spreadsheetId, chunk.map((r) => r.values));
    await prisma.sheetRow.createMany({ data: chunk.map((r) => ({ surveyId, contactId: r.contactId })), skipDuplicates: true });
  }
  return prisma.sheetSync.update({ where: { id: sync.id }, data: { lastSyncedAt: new Date(), rowsSynced: { increment: rows.length } } });
}

/** Called after each completion: appends that participant's row if auto-sync is on. Never throws into the webhook path. */
export async function autoSyncCompleted(surveyId: string, contactId: string) {
  const sync = await prisma.sheetSync.findUnique({ where: { surveyId } });
  if (!sync?.autoSync) return;
  if (!autoSyncActive(sync)) { await pauseAutoSync(sync); return; } // the owner has not confirmed lately: new rows wait for the next confirmed sync
  if (await prisma.sheetRow.findUnique({ where: { surveyId_contactId: { surveyId, contactId } } })) return;
  const survey = await surveyForSync(surveyId, sync.userId);
  const [row] = await rowsFor(survey, [contactId]);
  if (!row) return;
  await appendRows(sync.userId, sync.spreadsheetId, [row.values]);
  await prisma.sheetRow.createMany({ data: [{ surveyId, contactId }], skipDuplicates: true });
  await prisma.sheetSync.update({ where: { id: sync.id }, data: { lastSyncedAt: new Date(), rowsSynced: { increment: 1 } } });
}

/** Notes the pause (once per pause) and tells the owner. Nothing is lost: the next confirmed sync appends every row that is still missing. */
async function pauseAutoSync(sync: { id: string; surveyId: string; userId: string }) {
  const first = await prisma.sheetSync.updateMany({ where: { id: sync.id, autoSyncPausedAt: null }, data: { autoSyncPausedAt: new Date() } });
  if (first.count !== 1) return;
  const [user, survey] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: sync.userId }, select: { email: true, name: true, locale: true } }),
    prisma.survey.findUniqueOrThrow({ where: { id: sync.surveyId }, select: { title: true } }),
  ]);
  await audit({ userId: sync.userId }, { action: 'sheets_autosync_paused', targetType: 'survey', targetId: sync.surveyId });
  sendMailInBackground(user.email, 'sheets_sync_paused', user.locale === 'en' ? 'en' : 'fr', { name: user.name, what: survey.title, count: env.SHEETS_AUTOSYNC_DAYS, url: `${env.webBaseUrl}/surveys/${sync.surveyId}/export` });
}
