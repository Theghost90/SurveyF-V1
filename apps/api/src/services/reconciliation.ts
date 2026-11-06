import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { audit } from './audit';
import { sendMail } from './mail';
import { xafEquivalent } from './payout-limits';

/**
 * Daily reconciliation (PAY-02): a silent cash shortfall is the failure that nobody sees until a payout is refused. Two kinds of check, kept apart because only
 * the first can be exact:
 *
 *   1. INSIDE SurveyFlow, exact (integers, no provider needed): every wallet balance is the sum of its ledger; no balance is negative; every paid-out or in-flight
 *      gift holds exactly what it cost in the ledger and a refund exists exactly when the gift was refunded; every wallet top-up in the ledger matches ONE successful
 *      payment for the same amount, and every successful top-up payment reached a wallet. Any difference is a bug, a failed activation or tampering.
 *   2. AGAINST THE PROVIDERS: what customers' wallets and payouts in flight add up to (what SurveyFlow owes) against what the payment providers say the merchant
 *      accounts hold. Money is spread over several providers and currencies, so it is compared as a whole, in CFA francs, at rates already known: no rate, no
 *      conversion, and the sum says so. A balance comes from a typed-in figure or, for the providers where it is both documented and needs no new credential, from
 *      their API (BALANCE_SOURCES, off by default). The comparison is only made when every provider that ever received a wallet top-up has a FRESH balance: a partial
 *      sum against a full debt would be a false alarm every day.
 *
 * Containment (the backlog: read-only keys, thresholds, de-duplicated alerts; the stop-gap is a daily SQL check): nothing here writes to a provider (GET only,
 * enforced in `readOnlyGet`); a shortfall below a threshold in francs AND in percent is not an alarm; each finding raises one alert a day however often it is checked;
 * a failed read of a balance is "unknown", never a shortfall.
 */

export interface Finding { code: string; severity: 'alert' | 'info'; message: string; detail?: unknown }
export interface Report {
  at: string;
  ok: boolean;
  obligationsXAF: number | null;
  assetsXAF: number | null;
  shortfallXAF: number | null;
  wallets: Array<{ currency: string; amount: number; xaf: number | null }>;
  payoutsInFlight: Array<{ currency: string; amount: number; xaf: number | null }>;
  providers: Array<{ provider: string; currency: string; available: number; xaf: number | null; asOf: string; ageHours: number; fresh: boolean; source: string }>;
  findings: Finding[];
}

const HOUR = 3_600_000;
const day = (d: Date) => d.toISOString().slice(0, 10);

// ---- 1. inside SurveyFlow ------------------------------------------------------------------------------------------------------

async function ledgerFindings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const mismatch = await prisma.$queryRaw<Array<{ id: string; balance: number; ledger: number }>>`
    SELECT u."id", u."giftBalanceFCFA" AS balance, COALESCE(SUM(w."deltaFCFA"), 0)::int AS ledger
    FROM "User" u LEFT JOIN "WalletEntry" w ON w."userId" = u."id"
    GROUP BY u."id" HAVING u."giftBalanceFCFA" <> COALESCE(SUM(w."deltaFCFA"), 0)`;
  if (mismatch.length) out.push({ code: 'balance_vs_ledger', severity: 'alert', message: `${mismatch.length} wallet(s) whose balance is not the sum of their ledger (largest difference ${Math.max(...mismatch.map((m) => Math.abs(m.balance - m.ledger)))})`, detail: mismatch.slice(0, 5) });
  const negative = await prisma.user.findMany({ where: { giftBalance: { lt: 0 } }, select: { id: true, giftBalance: true }, take: 5 });
  if (negative.length) out.push({ code: 'negative_balance', severity: 'alert', message: `${negative.length} wallet(s) with a negative balance`, detail: negative });
  const noCurrency = await prisma.user.count({ where: { giftBalance: { gt: 0 }, giftCurrency: null } });
  if (noCurrency) out.push({ code: 'wallet_without_currency', severity: 'alert', message: `${noCurrency} wallet(s) hold money in no currency, so it cannot be priced or compared` });

  const gifts = await prisma.$queryRaw<Array<{ id: string; status: string; expected: number; actual: number }>>`
    SELECT g."id", g."status"::text AS status,
      (CASE WHEN g."status" IN ('pending', 'sent') OR (g."status" = 'failed' AND g."refundedAt" IS NULL) THEN -(g."amountFCFA" + g."feeFCFA") ELSE 0 END) AS expected,
      COALESCE(SUM(w."deltaFCFA"), 0)::int AS actual
    FROM "GiftDelivery" g LEFT JOIN "WalletEntry" w ON w."refId" = g."id" AND w."kind" IN ('gift_debit', 'gift_refund')
    WHERE g."giftType" IN ('airtime', 'momo') AND g."amountFCFA" IS NOT NULL
    GROUP BY g."id"
    HAVING COALESCE(SUM(w."deltaFCFA"), 0) <> (CASE WHEN g."status" IN ('pending', 'sent') OR (g."status" = 'failed' AND g."refundedAt" IS NULL) THEN -(g."amountFCFA" + g."feeFCFA") ELSE 0 END)`;
  if (gifts.length) out.push({ code: 'gift_ledger_mismatch', severity: 'alert', message: `${gifts.length} gift(s) whose cost in the ledger is not what its status says (a debit missing or doubled, or a refund without a failure)`, detail: gifts.slice(0, 5) });

  const topups = await prisma.$queryRaw<Array<{ id: string; refId: string | null; delta: number }>>`
    SELECT w."id", w."refId", w."deltaFCFA" AS delta
    FROM "WalletEntry" w LEFT JOIN "PaymentTransaction" p ON p."id" = w."refId"
    WHERE w."kind" = 'topup' AND (p."id" IS NULL OR p."status" <> 'success' OR p."purpose" <> 'gift_topup' OR p."amount" <> w."deltaFCFA")`;
  if (topups.length) out.push({ code: 'topup_without_payment', severity: 'alert', message: `${topups.length} wallet credit(s) that do not match one successful payment of the same amount: money in the wallet that never arrived`, detail: topups.slice(0, 5) });
  const doubled = await prisma.$queryRaw<Array<{ refId: string; n: number }>>`
    SELECT "refId", COUNT(*)::int AS n FROM "WalletEntry" WHERE "kind" = 'topup' AND "refId" IS NOT NULL GROUP BY "refId" HAVING COUNT(*) > 1`;
  if (doubled.length) out.push({ code: 'topup_credited_twice', severity: 'alert', message: `${doubled.length} payment(s) credited to a wallet more than once`, detail: doubled.slice(0, 5) });
  const lost = await prisma.$queryRaw<Array<{ id: string; reference: string; amount: number; currency: string }>>`
    SELECT p."id", p."reference", p."amount", p."currency" FROM "PaymentTransaction" p
    WHERE p."purpose" = 'gift_topup' AND p."status" = 'success' AND NOT EXISTS (SELECT 1 FROM "WalletEntry" w WHERE w."kind" = 'topup' AND w."refId" = p."id")`;
  if (lost.length) out.push({ code: 'payment_without_credit', severity: 'alert', message: `${lost.length} successful wallet top-up(s) that never reached a wallet: customers who paid and got nothing`, detail: lost.slice(0, 5) });
  return out;
}

// ---- 2. against the providers --------------------------------------------------------------------------------------------------

/** Providers that ever received a wallet top-up, and the gift provider when it is a real one: the places customers' money can be. */
async function providersHoldingMoney(): Promise<string[]> {
  const rows = await prisma.paymentTransaction.findMany({ where: { purpose: 'gift_topup', status: 'success', pspProvider: { not: 'mock' } }, distinct: ['pspProvider'], select: { pspProvider: true } });
  const set = new Set(rows.map((r) => r.pspProvider));
  if (env.giftProvider === 'campay') set.add('campay');
  return [...set].sort();
}

export async function recordBalance(b: { provider: string; currency: string; available: number; source: 'manual' | 'api'; asOf?: Date; note?: string }) {
  if (!Number.isFinite(b.available) || b.available < 0) throw new Error('a balance is a number of zero or more');
  return prisma.providerBalance.create({ data: { provider: b.provider.toLowerCase(), currency: b.currency.toUpperCase(), available: b.available, source: b.source, asOf: b.asOf ?? new Date(), note: b.note } });
}

async function latestBalances(now: Date): Promise<Report['providers']> {
  const rows = await prisma.providerBalance.findMany({ orderBy: { asOf: 'desc' }, distinct: ['provider', 'currency'] });
  const out: Report['providers'] = [];
  for (const r of rows) {
    const ageHours = (now.getTime() - r.asOf.getTime()) / HOUR;
    out.push({ provider: r.provider, currency: r.currency, available: r.available, xaf: await xafEquivalent(r.available, r.currency), asOf: r.asOf.toISOString(), ageHours: Math.round(ageHours * 10) / 10, fresh: ageHours <= env.RECONCILE_BALANCE_MAX_AGE_HOURS, source: r.source });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency));
}

/** What customers are owed, per currency: wallets, and gifts debited whose payout is not settled (pending, or failed with an unknown outcome: the money may still have to leave). */
async function owed() {
  const wallets = await prisma.user.groupBy({ by: ['giftCurrency'], where: { giftBalance: { gt: 0 } }, _sum: { giftBalance: true } });
  const inflight = await prisma.giftDelivery.groupBy({
    by: ['currency'],
    where: { giftType: { in: ['airtime', 'momo'] }, amount: { not: null }, OR: [{ status: 'pending' }, { status: 'failed', refundedAt: null }] },
    _sum: { amount: true },
  });
  const price = async (rows: Array<{ currency: string; amount: number }>) => Promise.all(rows.map(async (r) => ({ ...r, xaf: await xafEquivalent(r.amount, r.currency) })));
  return {
    wallets: await price(wallets.map((w) => ({ currency: w.giftCurrency ?? 'XAF', amount: w._sum.giftBalance ?? 0 }))),
    payoutsInFlight: await price(inflight.map((g) => ({ currency: g.currency, amount: g._sum.amount ?? 0 }))),
  };
}

// ---- reading balances from the providers ---------------------------------------------------------------------------------------

export interface BalanceReading { provider: string; currency: string; available: number }
type Fetch = typeof fetch;

/** The only way this module talks to a provider: a GET, with a timeout. There is no code path that sends anything else. */
async function readOnlyGet(url: string, headers: Record<string, string>, fetchImpl: Fetch): Promise<unknown> {
  const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Balances SurveyFlow may read with credentials it ALREADY holds for taking payments. Flutterwave: GET /v3/balances, documented by Flutterwave. Campay: GET /api/balance/,
 * known only from third-party SDKs, not from Campay's own pages. Notch Pay needs a private key that is not configured here, CinetPay needs a login token, CamerPay's
 * endpoint was not found: their balances are typed in. NONE OF THESE HAS BEEN RUN AGAINST THE REAL SERVICE: the tests feed them the documented answers.
 * These keys are not read-only keys (no provider offered one that could be confirmed): that is a risk taken only when the provider is listed in BALANCE_SOURCES.
 */
export const BALANCE_FETCHERS: Record<string, { configured: () => boolean; read: (f: Fetch) => Promise<BalanceReading[]> }> = {
  flutterwave: {
    configured: () => !!env.FLUTTERWAVE_SECRET_KEY,
    async read(f) {
      const j = (await readOnlyGet('https://api.flutterwave.com/v3/balances', { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` }, f)) as { status?: string; data?: Array<{ currency?: string; available_balance?: number }> };
      if (j.status !== 'success' || !Array.isArray(j.data)) throw new Error('unexpected answer');
      return j.data.filter((d) => d.currency && typeof d.available_balance === 'number').map((d) => ({ provider: 'flutterwave', currency: d.currency!, available: d.available_balance! }));
    },
  },
  campay: {
    configured: () => !!env.CAMPAY_API_KEY,
    async read(f) {
      const base = env.CAMPAY_ENV === 'prod' ? 'https://campay.net/api' : 'https://demo.campay.net/api';
      const j = (await readOnlyGet(`${base}/balance/`, { Authorization: `Token ${env.CAMPAY_API_KEY}` }, f)) as { total_balance?: number; currency?: string };
      if (typeof j.total_balance !== 'number') throw new Error('unexpected answer');
      return [{ provider: 'campay', currency: j.currency ?? 'XAF', available: j.total_balance }];
    },
  },
};

/** Reads the balances of the providers named in BALANCE_SOURCES and stores them. A provider that cannot be read is reported, never turned into a figure. */
export async function fetchProviderBalances(now = new Date(), fetchImpl: Fetch = fetch): Promise<Finding[]> {
  const notes: Finding[] = [];
  for (const name of env.BALANCE_SOURCES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const f = BALANCE_FETCHERS[name];
    if (!f) { notes.push({ code: 'balance_source_unknown', severity: 'info', message: `BALANCE_SOURCES names "${name}", which cannot be read by SurveyFlow (readable: ${Object.keys(BALANCE_FETCHERS).join(', ')}): type its balance in` }); continue; }
    if (!f.configured()) { notes.push({ code: 'balance_source_unconfigured', severity: 'info', message: `${name} is in BALANCE_SOURCES but its credentials are not set` }); continue; }
    try {
      for (const r of await f.read(fetchImpl)) await recordBalance({ ...r, source: 'api', asOf: now });
    } catch (err) {
      notes.push({ code: 'balance_unreadable', severity: 'info', message: `the balance of ${name} could not be read (${(err as Error).message}): the last one on record is used until it is too old` });
    }
  }
  return notes;
}

// ---- the report ----------------------------------------------------------------------------------------------------------------

export async function buildReport(now = new Date()): Promise<Report> {
  const findings = await ledgerFindings();
  const { wallets, payoutsInFlight } = await owed();
  const providers = await latestBalances(now);
  const unconverted = [...wallets, ...payoutsInFlight].filter((r) => r.xaf === null);
  for (const u of unconverted) findings.push({ code: 'fx_unavailable', severity: 'info', message: `${u.amount} ${u.currency} owed to customers cannot be priced in CFA francs: no exchange rate is known, so it is left out of the comparison` });
  for (const p of providers.filter((x) => x.xaf === null)) findings.push({ code: 'fx_unavailable', severity: 'info', message: `the ${p.currency} balance of ${p.provider} cannot be priced in CFA francs: no exchange rate is known` });
  const sum = (rows: Array<{ xaf: number | null }>) => rows.reduce((a, r) => a + (r.xaf ?? 0), 0);
  const obligationsXAF = sum(wallets) + sum(payoutsInFlight);

  let assetsXAF: number | null = null;
  let shortfallXAF: number | null = null;
  if (obligationsXAF > 0) {
    const needed = await providersHoldingMoney();
    const fresh = providers.filter((p) => p.fresh);
    const missing = needed.filter((p) => !fresh.some((f) => f.provider === p));
    if (!needed.length) {
      // Wallets hold money but no real provider ever received a top-up: a demo (the mock provider), not a shortfall. Comparing with "nothing held" would be a false alarm.
      findings.push({ code: 'no_provider_holds_money', severity: 'info', message: `customers are owed ${obligationsXAF} XAF but no real payment provider has received a wallet top-up (the mock one in a demo): there is nothing to compare it with` });
    } else if (missing.length) {
      const detail = missing.map((p) => { const last = providers.filter((x) => x.provider === p).sort((a, b) => a.ageHours - b.ageHours)[0]; return last ? `${p} (last ${Math.round(last.ageHours)} h ago)` : `${p} (never)`; }).join(', ');
      findings.push({ code: 'provider_balance_missing', severity: 'alert', message: `no fresh balance (under ${env.RECONCILE_BALANCE_MAX_AGE_HOURS} h) for ${detail}: customers are owed ${obligationsXAF} XAF and it cannot be compared with what the providers hold. Type the balances in: scripts/reconcile.mts balance <provider> <amount>`, detail: { missing } });
    } else {
      assetsXAF = sum(fresh);
      shortfallXAF = obligationsXAF - assetsXAF;
      const threshold = Math.max(env.RECONCILE_MIN_SHORTFALL_XAF, Math.ceil((obligationsXAF * env.RECONCILE_MIN_SHORTFALL_PERCENT) / 100));
      if (shortfallXAF > threshold) findings.push({ code: 'provider_shortfall', severity: 'alert', message: `customers are owed ${obligationsXAF} XAF (wallets and payouts in flight) and the providers hold ${assetsXAF} XAF: ${shortfallXAF} XAF short (the alarm starts above ${threshold})`, detail: { obligationsXAF, assetsXAF, shortfallXAF, threshold } });
    }
  }
  return { at: now.toISOString(), ok: !findings.some((f) => f.severity === 'alert'), obligationsXAF, assetsXAF, shortfallXAF, wallets, payoutsInFlight, providers, findings };
}

/** One alert a day for each finding, however often the check runs. Returns the findings that were new today. */
async function alertOnce(report: Report, now: Date): Promise<Finding[]> {
  const fresh: Finding[] = [];
  for (const f of report.findings.filter((x) => x.severity === 'alert')) {
    if ((await redis.set(`sf:reconcile:${f.code}:${day(now)}`, '1', 'EX', 26 * 3600, 'NX')) === 'OK') fresh.push(f);
  }
  if (!fresh.length) return [];
  await audit({ userId: null }, { action: 'reconciliation_alert', meta: { codes: fresh.map((f) => f.code).join(',') } });
  if (env.OPERATOR_EMAIL) {
    await sendMail(env.OPERATOR_EMAIL, 'reconciliation_alert', env.OPERATOR_LOCALE, { items: fresh.map((f) => f.message) }).catch((err) => console.error('reconciliation alert mail failed', (err as Error).message));
  } else {
    console.error('RECONCILIATION', fresh.map((f) => f.message));
  }
  return fresh;
}

/** Reads the balances that may be read, builds the report, records the run, and raises the alerts that are new today. */
export async function runReconciliation(opts: { now?: Date; source?: 'job' | 'cli'; fetchBalances?: boolean; fetchImpl?: Fetch } = {}): Promise<Report> {
  const now = opts.now ?? new Date();
  const notes = opts.fetchBalances === false ? [] : await fetchProviderBalances(now, opts.fetchImpl);
  const report = await buildReport(now);
  report.findings.push(...notes);
  await prisma.reconciliationRun.create({ data: { at: now, source: opts.source ?? 'job', ok: report.ok, obligationsXAF: report.obligationsXAF, assetsXAF: report.assetsXAF, findings: report.findings as never, report: report as never } });
  await alertOnce(report, now);
  return report;
}

/** The scheduled entry: once a day, whatever the interval it is called at. */
export async function runDailyReconciliation(now = new Date()): Promise<{ ran: boolean; ok?: boolean }> {
  const last = await prisma.reconciliationRun.findFirst({ where: { source: 'job' }, orderBy: { at: 'desc' }, select: { at: true } });
  if (last && now.getTime() - last.at.getTime() < 23 * HOUR) return { ran: false };
  const r = await runReconciliation({ now, source: 'job' });
  return { ran: true, ok: r.ok };
}
