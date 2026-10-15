import { CURRENCIES, XAF_PER_EUR, eurQuote, identityQuote, isCfa, type Currency, type FxQuote } from '@surveyflow/shared';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';

/**
 * Live exchange rates: FCFA → the visitor's currency.
 *
 * Source: ExchangeRate-API's open endpoint (open.er-api.com, base XAF, no key, refreshed once a day, free for commercial use with
 * attribution — shown next to every converted price). Google has no public rate API; this one covers every currency we sell in.
 * Override with FX_API_URL if you prefer another source with the same response shape ({ rates, time_last_update_unix }).
 *
 * Rules, in order of importance:
 *  1. NEVER invent a rate. No fresh rate → the caller falls back to FCFA (null from getQuote), it does not guess.
 *  2. CFA francs (XAF, XOF) and the euro need no live rate: they are fixed pegs (1 : 1 and 655.957 per EUR).
 *  3. A table is cached in Redis (FX_CACHE_MINUTES) and every accepted rate is also written to the FxRate table, the last-known-good
 *     copy used when the source is down. It may be used for at most FX_MAX_STALE_HOURS after the source published it.
 *  4. A new rate that differs by more than 50 % from the last known one is rejected as a bad data point (and logged).
 */

const CACHE_KEY = 'sf:fx:table:v1';
const LIVE = CURRENCIES.filter((c) => !isCfa(c) && c !== 'EUR');
const HOUR = 3_600_000;

export interface RateTable {
  /** units of currency per 1 XAF */
  rates: Partial<Record<Currency, number>>;
  /** when the source published this table (ISO), null if it did not say */
  sourceUpdatedAt: string | null;
  fetchedAt: string;
}

let inflight: Promise<RateTable | null> | null = null;

async function fetchLive(): Promise<RateTable> {
  const res = await fetch(env.FX_API_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`fx source HTTP ${res.status}`);
  const j = (await res.json()) as { result?: string; base_code?: string; rates?: Record<string, number>; time_last_update_unix?: number };
  if ((j.result && j.result !== 'success') || !j.rates) throw new Error('fx source returned no rates');
  if (j.base_code && j.base_code !== 'XAF') throw new Error(`fx source base is ${j.base_code}, expected XAF`);
  const rates: RateTable['rates'] = {};
  for (const c of LIVE) {
    const r = j.rates[c];
    if (typeof r === 'number' && Number.isFinite(r) && r > 0) rates[c] = r;
  }
  if (!Object.keys(rates).length) throw new Error('fx source had none of the currencies we sell in');
  return {
    rates,
    sourceUpdatedAt: j.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString() : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function lastKnown(): Promise<RateTable | null> {
  const rows = await prisma.fxRate.findMany();
  if (!rows.length) return null;
  const rates: RateTable['rates'] = {};
  let fetchedAt = 0;
  let sourceUpdatedAt = 0;
  for (const r of rows) {
    rates[r.currency as Currency] = r.rate;
    fetchedAt = Math.max(fetchedAt, r.fetchedAt.getTime());
    sourceUpdatedAt = Math.max(sourceUpdatedAt, r.sourceUpdatedAt?.getTime() ?? 0);
  }
  return { rates, sourceUpdatedAt: sourceUpdatedAt ? new Date(sourceUpdatedAt).toISOString() : null, fetchedAt: new Date(fetchedAt).toISOString() };
}

/** Drops (and logs) any rate that jumped more than 50 % from the last accepted one: almost certainly bad data, not a real devaluation. */
function sanity(next: RateTable, prev: RateTable | null, log: (o: unknown, m: string) => void): RateTable {
  if (!prev) return next;
  const rates = { ...next.rates };
  for (const [c, r] of Object.entries(next.rates) as Array<[Currency, number]>) {
    const p = prev.rates[c];
    if (p && (r / p > 1.5 || r / p < 1 / 1.5)) {
      log({ currency: c, previous: p, received: r }, 'fx: rejected an implausible jump, keeping the previous rate');
      rates[c] = p;
    }
  }
  return { ...next, rates };
}

/** Refreshes from the source (single flight). Returns the accepted table, or null when the source failed (callers keep what they have). */
export async function refreshRates(log: (o: unknown, m: string) => void = (o, m) => console.warn(m, o)): Promise<RateTable | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fresh = sanity(await fetchLive(), await lastKnown(), log);
      await Promise.all(Object.entries(fresh.rates).map(([currency, rate]) => prisma.fxRate.upsert({
        where: { currency }, create: { currency, rate: rate!, sourceUpdatedAt: fresh.sourceUpdatedAt ? new Date(fresh.sourceUpdatedAt) : null, fetchedAt: new Date(fresh.fetchedAt) },
        update: { rate: rate!, sourceUpdatedAt: fresh.sourceUpdatedAt ? new Date(fresh.sourceUpdatedAt) : null, fetchedAt: new Date(fresh.fetchedAt) },
      })));
      await redis.set(CACHE_KEY, JSON.stringify(fresh), 'EX', env.FX_CACHE_MINUTES * 60);
      return fresh;
    } catch (err) {
      log({ err: (err as Error).message }, 'fx: could not refresh rates');
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * The table to price with: Redis → live fetch → last-known-good. With `{ fetch: false }` the network is never touched (Redis →
 * last-known-good only): for callers that must not wait on it, like ranking providers inside a payment.
 */
export async function getRateTable(opts: { fetch?: boolean } = {}): Promise<RateTable | null> {
  const cached = await redis.get(CACHE_KEY).catch(() => null);
  if (cached) { try { return JSON.parse(cached) as RateTable; } catch { /* corrupt entry: refetch */ } }
  if (opts.fetch === false) return lastKnown();
  return (await refreshRates()) ?? (await lastKnown());
}

const ageHours = (t: RateTable) => (Date.now() - new Date(t.sourceUpdatedAt ?? t.fetchedAt).getTime()) / HOUR;

/**
 * Quote for `currency`, or null when no usable rate exists (never guessed). `source` says how fresh it is: 'live' within 36 h of
 * publication, 'stale' up to FX_MAX_STALE_HOURS, beyond that no quote at all.
 */
export async function getQuote(currency: Currency): Promise<FxQuote | null> {
  if (isCfa(currency)) return identityQuote(currency);
  if (currency === 'EUR') return eurQuote();
  const table = await getRateTable();
  const rate = table?.rates[currency];
  if (!table || !rate) return null;
  const age = ageHours(table);
  if (age > env.FX_MAX_STALE_HOURS) return null;
  return { currency, rate, asOf: table.sourceUpdatedAt ?? table.fetchedAt, source: age <= 36 ? 'live' : 'stale' };
}

/** The quote to use for pricing/charging, with the honest fallback: no rate → CFA francs, and `fallback: true` says so. */
export async function quoteOrXaf(currency: Currency): Promise<{ quote: FxQuote; fallback: boolean }> {
  const q = await getQuote(currency);
  return q ? { quote: q, fallback: false } : { quote: identityQuote('XAF'), fallback: true };
}

/**
 * Synchronous converter of a fixed fee (e.g. $0.30) to XAF for provider ranking; null where no rate is available (the fixed part is
 * then left out of the comparison). Reads only what is already cached: choosing a provider never waits on the rate source.
 */
export async function fixedFeeConverter(): Promise<(amount: number, currency: Currency) => number | null> {
  const table = await getRateTable({ fetch: false });
  return (amount, currency) => {
    if (isCfa(currency)) return amount;
    if (currency === 'EUR') return amount * XAF_PER_EUR;
    const r = table?.rates[currency];
    return r && ageHours(table!) <= env.FX_MAX_STALE_HOURS ? amount / r : null;
  };
}
