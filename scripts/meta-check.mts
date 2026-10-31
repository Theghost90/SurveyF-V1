/**
 * Real-Meta check. Runs the PRODUCTION WhatsApp gateway (apps/api/src/services/whatsapp/cloud.ts) against Meta with YOUR credentials and
 * reports PASS / WARN / FAIL per check, so every "never run against real Meta" assumption of the integration is either confirmed or
 * shown with Meta's own error message. It talks only to graph.facebook.com and (webhook checks) to your own API. Secrets are never printed.
 *
 *   npx tsx --env-file=.env scripts/meta-check.mts [options]
 *
 *   --to <number>          also send one message of every kind we use (text, buttons, list, link button, template) to this WhatsApp number,
 *                          digits with country code, e.g. 2376XXXXXXXX. Free-form messages only deliver inside WhatsApp's 24 h window:
 *                          first send ANY message from that phone to your business number.
 *   --create-templates     submit the templates Meta does not know yet (they then wait for Meta's review, minutes to hours)
 *   --subscribe            subscribe your app to the WABA's webhooks if it is not yet
 *   --webhook-url <url>    base URL of the API whose webhook is tested (default PUBLIC_API_URL). Must be public for Meta; localhost only proves the code.
 *   --fake-graph           self-test of THIS script against a fake Graph API (no credentials needed). Proves nothing about Meta.
 *
 * Needs in .env: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID, META_APP_SECRET, WHATSAPP_VERIFY_TOKEN
 * (and META_APP_ID to inspect the token). See docs/META_CHECK.md for how to get them from a Meta test app and what this cannot cover.
 */
import { createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FAKE = flag('fake-graph');

if (FAKE) {
  // Values the fake Graph below answers for. Real credentials in the environment are replaced so that nothing real is ever contacted.
  Object.assign(process.env, {
    WHATSAPP_ACCESS_TOKEN: 'fake-token', WHATSAPP_PHONE_NUMBER_ID: '1000', WHATSAPP_BUSINESS_ACCOUNT_ID: '2000',
    META_APP_ID: '123', META_APP_SECRET: process.env.META_APP_SECRET || 'fake-app-secret', WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || 'fake-verify',
  });
  process.env.DATABASE_URL ??= 'postgresql://x:x@127.0.0.1:5432/x';
}

const { env } = await import('../apps/api/src/config/env');
const { CloudApiGateway } = await import('../apps/api/src/services/whatsapp/cloud');
const { WaError } = await import('../apps/api/src/services/whatsapp/gateway');
const { TEMPLATE_DEFS, TEMPLATE_NAMES, templateKey } = await import('@surveyflow/shared');

// ---- tiny reporting kit -------------------------------------------------------------------------------------------------------

type Level = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
const ICON: Record<Level, string> = { PASS: '✓', WARN: '!', FAIL: '✗', SKIP: '–' };
const counts: Record<Level, number> = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
function report(level: Level, name: string, detail = '') {
  counts[level]++;
  console.log(`${ICON[level]} ${level.padEnd(4)} ${name}${detail ? `\n         ${detail.replace(/\n/g, '\n         ')}` : ''}`);
}

/** Meta error codes whose meaning is worth spelling out (the raw message is always printed too). */
const HINTS: Record<number, string> = {
  190: 'the access token is invalid or expired: create a System User token that does not expire',
  10: 'the token lacks a permission (needs whatsapp_business_messaging and whatsapp_business_management)',
  200: 'the token lacks a permission (needs whatsapp_business_messaging and whatsapp_business_management)',
  100: 'Meta rejected a parameter: the message below says which',
  131030: 'a test number can only message recipients you added and verified in the app dashboard',
  131047: 'outside the 24 h window: send any message from that phone to your business number, then rerun',
  131026: 'undeliverable: the number is not on WhatsApp, or has not accepted the latest terms',
  132000: 'template parameter count does not match the template',
  132001: 'that template does not exist in that language (or is not approved yet)',
  131009: 'a parameter value is not valid',
};
const explain = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch failed|network error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return `${msg}\n→ cannot reach the server (for Meta checks: graph.facebook.com): check the internet connection, VPN, proxy or firewall`;
  const code = e instanceof WaError ? e.code : Number(/^(\d{2,6}):/.exec(msg)?.[1]);
  return code && HINTS[code] ? `${msg}\n→ ${HINTS[code]}` : msg;
};
async function check(name: string, fn: () => Promise<[Level, string?] | void>) {
  try {
    const r = await fn();
    if (r) report(r[0], name, r[1] ?? '');
  } catch (e) {
    report('FAIL', name, explain(e));
  }
}

// ---- Graph access (direct calls, for fields the production gateway does not read) ----------------------------------------

const TOKEN = env.WHATSAPP_ACCESS_TOKEN ?? '';
const PHONE_ID = env.WHATSAPP_PHONE_NUMBER_ID ?? '';
const WABA_ID = env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '';
const GRAPH = `https://graph.facebook.com/${env.META_GRAPH_VERSION}`;

async function graph(path: string, query: Record<string, string> = {}, bearer: string | null = TOKEN): Promise<any> {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(20_000) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${json.error?.code ?? res.status}: ${json.error?.message ?? res.statusText}`);
  return json;
}

// ---- fake Graph (self-test only) ------------------------------------------------------------------------------------------

const fakeSent: any[] = [];
if (FAKE) {
  const realFetch = globalThis.fetch;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const err = (code: number, message: string) => json({ error: { code, message } }, 400);
  let n = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    if (url.hostname !== 'graph.facebook.com') return realFetch(input, init);
    const p = url.pathname.replace(/^\/v[\d.]+\//, '');
    const method = init?.method ?? 'GET';
    if (p === 'debug_token') return json({ data: { app_id: '123', type: 'SYSTEM_USER', is_valid: true, expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] } });
    if (p === PHONE_ID) return json({ display_phone_number: '+1 555 000 0000', verified_name: 'Fake Biz', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', platform_type: 'CLOUD_API' });
    if (p === WABA_ID) return json({ name: 'Fake WABA', account_review_status: 'APPROVED', business_verification_status: 'verified' });
    if (p === `${WABA_ID}/subscribed_apps`) return json(method === 'POST' ? { success: true } : { data: [{ whatsapp_business_api_data: { id: '123' } }] });
    if (p === `${WABA_ID}/message_templates` && method === 'GET') {
      const some = TEMPLATE_DEFS.slice(0, 8).map((d, i) => ({ id: `t${i}`, name: d.name, language: d.language, status: i === 0 ? 'PENDING' : 'APPROVED', category: i === 2 ? 'MARKETING' : d.category }));
      return json({ data: some });
    }
    if (p === `${WABA_ID}/message_templates` && method === 'POST') return json({ id: `new${++n}`, status: 'PENDING' });
    if (p === `${PHONE_ID}/messages` && method === 'POST') {
      const body = JSON.parse(init.body);
      fakeSent.push(body);
      // limits Meta documents for interactive messages
      const i = body.interactive;
      if (body.type === 'text' && body.text.body.length > 4096) return err(100, 'text body too long');
      if (i?.type === 'button' && (i.action.buttons.length > 3 || i.action.buttons.some((b: any) => b.reply.title.length > 20))) return err(100, 'reply button: max 3 buttons, title max 20 characters');
      if (i?.type === 'list' && (i.action.button.length > 20 || i.action.sections[0].rows.length > 10 || i.action.sections[0].rows.some((r: any) => r.title.length > 24))) return err(100, 'list: button max 20, rows max 10, row title max 24 characters');
      if (i?.type === 'cta_url' && (i.action.parameters.display_text.length > 20 || !/^https?:\/\//.test(i.action.parameters.url))) return err(100, 'cta_url: display_text max 20 characters and an http(s) url');
      if (process.env.FAKE_WINDOW_CLOSED && body.type !== 'template') return err(131047, 'Re-engagement message');
      return json({ messages: [{ id: `wamid.FAKE${++n}` }] });
    }
    return err(100, `fake graph: no route for ${method} ${p}`);
  }) as typeof fetch;
}

// ---- the checks -------------------------------------------------------------------------------------------------------------

console.log(`\nSurveyFlow real-Meta check${FAKE ? '  [FAKE GRAPH: self-test, nothing real is contacted]' : ''}\nGraph ${env.META_GRAPH_VERSION}\n`);

const REQUIRED = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'META_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const;
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  report('FAIL', 'configuration', `missing in .env: ${missing.join(', ')}\nSee docs/META_CHECK.md for where each one comes from.`);
  console.log('\nNothing else can run without these.');
  process.exit(1);
}
report('PASS', 'configuration', 'all required variables are set');
if (!env.META_APP_ID || !env.META_EMBEDDED_SIGNUP_CONFIG_ID) report('WARN', 'Embedded Signup configuration', 'META_APP_ID / META_EMBEDDED_SIGNUP_CONFIG_ID are not both set: owners can still connect by pasting credentials, but the one-click Meta popup is off.');

const gw = new CloudApiGateway();
const creds = { phoneNumberId: PHONE_ID, wabaId: WABA_ID, accessToken: TOKEN };

await check('access token', async () => {
  if (!env.META_APP_ID) return ['SKIP', 'set META_APP_ID to inspect the token (scopes, expiry)'];
  const d = (await graph('debug_token', { input_token: TOKEN, access_token: `${env.META_APP_ID}|${env.META_APP_SECRET}` }, null)).data ?? {};
  if (!d.is_valid) throw new Error(`token is not valid: ${d.error?.message ?? 'unknown reason'}`);
  const scopes: string[] = d.scopes ?? [];
  const lacking = ['whatsapp_business_messaging', 'whatsapp_business_management'].filter((s) => !scopes.includes(s));
  if (lacking.length) throw new Error(`token lacks scopes: ${lacking.join(', ')}`);
  if (d.app_id && String(d.app_id) !== String(env.META_APP_ID)) return ['WARN', `token belongs to app ${d.app_id}, not META_APP_ID`];
  const left = d.expires_at ? (d.expires_at * 1000 - Date.now()) / 3_600_000 : Infinity;
  if (left < 48) return ['WARN', `valid, but it expires in ${Math.max(0, Math.round(left))} h: a temporary token. Create a System User token for anything beyond a smoke test.`];
  return ['PASS', `${d.type ?? 'token'}, ${left === Infinity ? 'does not expire' : `expires in ${Math.round(left / 24)} days`}, required scopes present`];
});

await check('phone number', async () => {
  const prod = await gw.getPhoneInfo(creds); // the production code path
  const x = await graph(PHONE_ID, { fields: 'quality_rating,code_verification_status,platform_type' });
  const bits = [`${prod.displayPhone}${prod.verifiedName ? ` "${prod.verifiedName}"` : ''}`, `quality ${x.quality_rating ?? 'n/a'}`, x.platform_type ?? ''].filter(Boolean).join(', ');
  if (x.platform_type && x.platform_type !== 'CLOUD_API') return ['WARN', `${bits}\nthe number is not on the Cloud API: this product needs it there`];
  if (x.quality_rating === 'RED' || x.quality_rating === 'YELLOW') return ['WARN', `${bits}\nquality is ${x.quality_rating}: sending volume may be limited`];
  if (x.code_verification_status && x.code_verification_status !== 'VERIFIED') return ['WARN', `${bits}\nthe number's verification status is ${x.code_verification_status}`];
  return ['PASS', bits];
});

await check('business account', async () => {
  const w = await graph(WABA_ID, { fields: 'name,account_review_status,business_verification_status' });
  const bits = `"${w.name}", review ${w.account_review_status ?? 'n/a'}, business verification ${w.business_verification_status ?? 'n/a'}`;
  if (w.account_review_status && w.account_review_status !== 'APPROVED') return ['WARN', `${bits}\nthe account is not approved: sending may be restricted`];
  if (w.business_verification_status && w.business_verification_status !== 'verified') return ['WARN', `${bits}\nthe business is not verified: required to be a Tech Provider and for higher sending limits`];
  return ['PASS', bits];
});

await check('webhook subscription (app ↔ business account)', async () => {
  const subs = await graph(`${WABA_ID}/subscribed_apps`);
  const apps: any[] = subs.data ?? [];
  const ours = env.META_APP_ID ? apps.some((a) => String(a.whatsapp_business_api_data?.id) === String(env.META_APP_ID)) : apps.length > 0;
  if (ours) return ['PASS', `${apps.length} app(s) subscribed`];
  if (flag('subscribe')) {
    await gw.subscribeApp(creds); // the production code path
    return ['PASS', 'was not subscribed: subscribed now'];
  }
  throw new Error('this business account does not deliver webhooks to your app. Rerun with --subscribe.');
});

// templates -----------------------------------------------------------------------------------------------------------------
const remoteStatus = new Map<string, string>();
await check('message templates', async () => {
  const viaGateway = await gw.listTemplates(creds); // the production code path
  const detailed: any[] = (await graph(`${WABA_ID}/message_templates`, { fields: 'name,language,status,category,rejected_reason', limit: '200' })).data ?? [];
  const byKey = new Map(detailed.map((t) => [templateKey(t.name, t.language), t]));
  const lines: string[] = [];
  let level: Level = 'PASS';
  const raise = (l: Level) => { if (l === 'FAIL' || (l === 'WARN' && level === 'PASS')) level = l; };
  for (const def of TEMPLATE_DEFS) {
    const key = templateKey(def.name, def.language);
    let t = byKey.get(key);
    if (!t && flag('create-templates')) {
      try {
        const made = await gw.createTemplate(creds, def); // the production code path
        lines.push(`${key.padEnd(34)} created → ${made.status}`);
        remoteStatus.set(key, made.status);
        raise('WARN');
        continue;
      } catch (e) {
        lines.push(`${key.padEnd(34)} CREATE FAILED: ${explain(e).replace(/\n/g, ' ')}`);
        raise('FAIL');
        continue;
      }
    }
    if (!t) { lines.push(`${key.padEnd(34)} missing (rerun with --create-templates)`); raise('WARN'); continue; }
    remoteStatus.set(key, t.status);
    const recat = t.category && t.category !== def.category ? `  ⚠ Meta categorised it ${t.category}, we declare ${def.category}` : '';
    lines.push(`${key.padEnd(34)} ${t.status}${t.rejected_reason && t.rejected_reason !== 'NONE' ? ` (${t.rejected_reason})` : ''}${recat}`);
    if (t.status === 'REJECTED') raise('FAIL');
    else if (t.status !== 'APPROVED' || recat) raise('WARN');
  }
  lines.push(`(gateway listing returned ${viaGateway.length} templates)`);
  return [level, lines.join('\n')];
});

// real sends -----------------------------------------------------------------------------------------------------------------
const to = opt('to')?.replace(/\D/g, '');
if (!to) {
  report('SKIP', 'sending every message kind', 'pass --to <your WhatsApp number> to send a text, buttons, a list, a link button and an invitation template');
} else {
  const base = (env.PUBLIC_API_URL ?? 'https://example.invalid').replace(/\/$/, '');
  const pause = () => new Promise((r) => setTimeout(r, FAKE ? 0 : 700));
  const sends: Array<[string, () => Promise<{ messageId: string }>]> = [
    ['text message', () => gw.sendMessage(creds, to, { kind: 'text', body: 'SurveyFlow check 1/5: a plain text message.' })],
    ['reply buttons', () => gw.sendMessage(creds, to, { kind: 'buttons', body: 'SurveyFlow check 2/5: three reply buttons.', buttons: [{ id: 'a:check:1', title: 'Good' }, { id: 'a:check:2', title: 'Average' }, { id: 'a:check:3', title: 'Bad' }] })],
    ['list message', () => gw.sendMessage(creds, to, { kind: 'list', body: 'SurveyFlow check 3/5: a list.', buttonLabel: 'See options', rows: [{ id: 'a:check:1', title: 'Option one' }, { id: 'a:check:2', title: 'Option two', description: 'with a description' }] })],
    ['link button (cta_url)', () => gw.sendMessage(creds, to, { kind: 'link', body: 'SurveyFlow check 4/5: a message with one link button.', buttonLabel: 'Download receipt', url: `${base}/api/receipts/meta-check` })],
  ];
  for (const [name, send] of sends) {
    await check(`send: ${name}`, async () => { const r = await send(); return ['PASS', `accepted by Meta (${r.messageId})`]; });
    await pause();
  }
  await check('send: invitation template', async () => {
    const key = templateKey(TEMPLATE_NAMES.invitation, 'en');
    if (remoteStatus.get(key) !== 'APPROVED') return ['SKIP', `${key} is ${remoteStatus.get(key) ?? 'unknown'}, not APPROVED: wait for Meta's review, then rerun`];
    const r = await gw.sendTemplate(creds, to, { name: TEMPLATE_NAMES.invitation, language: 'en', bodyParams: ['Check', 'SurveyFlow', '2'], buttonPayloads: ['START:meta-check', 'DECLINE:meta-check'] });
    return ['PASS', `accepted by Meta (${r.messageId}); tap "Start survey" on the phone, your webhook should receive a button reply`];
  });
}

// your own webhook ------------------------------------------------------------------------------------------------------------
{
  const root = (opt('webhook-url') ?? env.PUBLIC_API_URL).replace(/\/$/, '');
  const url = `${root}/api/webhook/whatsapp`;
  const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.)/i.test(root);
  const call = (u: string, init?: RequestInit) => fetch(u, { ...init, signal: AbortSignal.timeout(15_000) });
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '0', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'meta-check-ignored' }, messages: [] } }] }] });
  await check(`your webhook ${root}`, async () => {
    let r: Response;
    try { r = await call(`${url}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.WHATSAPP_VERIFY_TOKEN ?? '')}&hub.challenge=meta-check-123`); }
    catch (e) { throw new Error(`cannot reach it: ${(e as Error).message}`); }
    const echoed = await r.text();
    if (r.status !== 200 || echoed !== 'meta-check-123') throw new Error(`verification handshake answered ${r.status} ${JSON.stringify(echoed.slice(0, 80))} instead of echoing the challenge: is WHATSAPP_VERIFY_TOKEN here the same value as on the API and in the Meta app dashboard?`);
    const bad = await call(`${url}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
    if (bad.status !== 403) throw new Error(`a wrong verify token was answered ${bad.status}, expected 403`);
    const unsigned = await call(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
    if (unsigned.status !== 401) throw new Error(`an UNSIGNED post was answered ${unsigned.status}, expected 401: the API is not verifying Meta's signature (META_APP_SECRET missing on the API?)`);
    const sig = 'sha256=' + createHmac('sha256', env.META_APP_SECRET ?? '').update(payload).digest('hex');
    const signed = await call(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload });
    if (signed.status !== 200) throw new Error(`a correctly SIGNED post was answered ${signed.status}, expected 200: the API and this script use different META_APP_SECRET values`);
    return local
      ? ['WARN', 'handshake, wrong token (403), unsigned (401) and signed (200) all behave. But this address is local: Meta cannot reach it. Use a public https URL (e.g. a tunnel) in the app dashboard.']
      : ['PASS', 'handshake, wrong token (403), unsigned (401) and signed (200) all behave'];
  });
}

// ---- summary ---------------------------------------------------------------------------------------------------------------

console.log(`\n${counts.PASS} passed, ${counts.WARN} warnings, ${counts.FAIL} failed, ${counts.SKIP} skipped.`);
if (FAKE) console.log(`(self-test: ${fakeSent.length} messages were built by the production code and checked against Meta's documented limits)`);
console.log(`\nNot coverable by a script, do these by hand (docs/META_CHECK.md):
  • Tech Provider status: business verification + app review for whatsapp_business_messaging / whatsapp_business_management (advanced access)
  • the Embedded Signup popup, run in a browser by someone with a role on your Meta app
  • the callback fields subscribed in the app dashboard (messages, message_template_status_update, template_category_update)
  • a real inbound round trip: tap a button on your phone and watch the survey start in the dashboard`);
process.exit(counts.FAIL ? 1 : 0);
