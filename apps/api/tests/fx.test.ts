import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { fixedFeeConverter, getQuote, quoteOrXaf, refreshRates } from '../src/services/fx';
import { makeApp, resetAll } from './helpers';

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); await prisma.fxRate.deleteMany(); });
afterEach(() => vi.unstubAllGlobals());

const NOW = () => Math.floor(Date.now() / 1000);
const feed = (over: Record<string, number> = {}, updated = NOW()) => ({
  result: 'success', base_code: 'XAF', time_last_update_unix: updated,
  rates: { NGN: 2.4, KES: 0.2, GHS: 0.018, USD: 1 / 580, GBP: 1 / 770, ZAR: 0.03, UGX: 6.4, ...over },
});
const stub = (body: unknown, ok = true) => {
  const fn = vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
};
const pricing = (country?: string) => app.inject({ method: 'GET', url: '/api/pricing', headers: country ? { 'x-sf-country': country } : {} }).then((r) => JSON.parse(r.body));

describe('live exchange rates', () => {
  it('CFA francs and the euro never touch the network', async () => {
    const f = stub(feed());
    expect(await getQuote('XAF')).toMatchObject({ rate: 1, source: 'identity' });
    expect(await getQuote('XOF')).toMatchObject({ currency: 'XOF', rate: 1 });
    expect((await getQuote('EUR'))!.rate).toBeCloseTo(1 / 655.957, 8);
    expect(f).not.toHaveBeenCalled();
  });

  it('fetches once, serves the rest from the cache, and reports the time the source published', async () => {
    const published = NOW() - 3_600;
    const f = stub(feed({}, published));
    const a = await getQuote('NGN');
    const b = await getQuote('KES');
    expect(a).toMatchObject({ currency: 'NGN', rate: 2.4, source: 'live' });
    expect(new Date(a!.asOf!).getTime() / 1000).toBe(published);
    expect(b!.rate).toBe(0.2);
    expect(f).toHaveBeenCalledTimes(1);
    expect(await prisma.fxRate.count()).toBe(7); // the last-known-good copy
  });

  it('when the source is down it falls back to the last known rate; when that is too old it gives NO quote (never a guess)', async () => {
    stub(feed());
    await refreshRates();
    await redis.flushdb(); // the hot cache is gone, the source is down
    stub({}, false);
    expect(await getQuote('NGN')).toMatchObject({ rate: 2.4 });
    // age the stored copy beyond FX_MAX_STALE_HOURS (72 h)
    await prisma.fxRate.updateMany({ data: { sourceUpdatedAt: new Date(Date.now() - 100 * 3_600_000), fetchedAt: new Date(Date.now() - 100 * 3_600_000) } });
    await redis.flushdb();
    expect(await getQuote('NGN')).toBeNull();
    const { quote, fallback } = await quoteOrXaf('NGN');
    expect(fallback).toBe(true);
    expect(quote).toMatchObject({ currency: 'XAF', rate: 1 });
  });

  it('a rate between 36 h and 72 h old is still used but marked stale', async () => {
    stub(feed({}, NOW() - 50 * 3_600));
    expect(await getQuote('USD')).toMatchObject({ source: 'stale' });
  });

  it('rejects a more-than-50 % jump as bad data and keeps the previous rate', async () => {
    stub(feed());
    await refreshRates();
    stub(feed({ NGN: 24, KES: 0.21 })); // NGN ×10: nonsense; KES +5 %: fine
    const warn = vi.fn();
    await refreshRates(warn);
    await redis.flushdb();
    expect((await getQuote('NGN'))!.rate).toBe(2.4);
    expect((await getQuote('KES'))!.rate).toBe(0.21);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ currency: 'NGN' }), expect.stringContaining('implausible'));
  });

  it('ignores garbage from the source (wrong base, negative or missing rates)', async () => {
    stub({ result: 'success', base_code: 'USD', rates: { NGN: 1500 } });
    expect(await getQuote('NGN')).toBeNull();
    await redis.flushdb();
    stub(feed({ NGN: -3, KES: NaN as never }));
    expect(await getQuote('NGN')).toBeNull(); // NGN rate rejected: no quote rather than a bad one
    expect(await getQuote('USD')).not.toBeNull(); // the valid ones survive
  });

  it('single flight: a burst of visitors causes one fetch', async () => {
    const f = stub(feed());
    await Promise.all(Array.from({ length: 12 }, () => getQuote('NGN')));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('converts a fixed fee in a foreign currency to XAF from what is cached — and never goes to the network to do it', async () => {
    const f = stub(feed());
    expect((await fixedFeeConverter())(0.3, 'USD')).toBeNull(); // nothing cached yet, and ranking does not fetch
    expect(f).not.toHaveBeenCalled();
    await refreshRates(); // the scheduler's job
    f.mockClear();
    const conv = await fixedFeeConverter();
    expect(conv(0.3, 'USD')).toBeCloseTo(174, 5);
    expect(conv(0.25, 'EUR')).toBeCloseTo(163.99, 1);
    expect(conv(10, 'XAF')).toBe(10);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('GET /api/pricing: public prices in the visitor\'s currency', () => {
  it('a Cameroonian / unknown visitor gets the FCFA prices untouched, and no network call is made', async () => {
    const f = stub(feed());
    for (const country of [undefined, 'CM', 'US']) {
      const p = await pricing(country);
      expect(p).toMatchObject({ currency: 'XAF', fallback: false, plans: { starter: { monthly: 14_500, annual: 145_000 }, growth: { monthly: 39_000 }, business: { monthly: 95_000, annual: 950_000 } }, overagePer100: 500 });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('a Nigerian visitor gets the FCFA prices converted at the live rate', async () => {
    stub(feed());
    const p = await pricing('NG');
    expect(p).toMatchObject({ country: 'NG', currency: 'NGN', fallback: false, requestedCurrency: 'NGN', overagePer100: 1_200 });
    expect(p.plans.starter).toEqual({ monthly: 34_800, annual: 348_000 }); // 14,500 × 2.4
    expect(p.plans.growth.monthly).toBe(93_600);
    expect(p.plansFCFA.starter.monthly).toBe(14_500);
    expect(p.quote).toMatchObject({ rate: 2.4, source: 'live' });
  });

  it('Kenya and Ghana use their own rates; a rate move changes the price', async () => {
    stub(feed());
    expect((await pricing('KE')).plans.starter.monthly).toBe(2_900); // 14,500 × 0.2
    expect((await pricing('GH')).plans.growth.monthly).toBe(702); // 39,000 × 0.018
    await redis.flushdb();
    stub(feed({ NGN: 3.0 }));
    expect((await pricing('NG')).plans.starter.monthly).toBe(43_500);
  });

  it('with no usable rate the visitor sees FCFA prices and an honest flag, never an invented conversion', async () => {
    stub({}, false);
    const p = await pricing('NG');
    expect(p).toMatchObject({ currency: 'XAF', requestedCurrency: 'NGN', fallback: true });
    expect(p.plans.starter.monthly).toBe(14_500);
  });
});
