import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { PSPRouter } from '../src/services/payments/router';
import { initiatePayment, refreshTransaction, settleTransaction } from '../src/services/payments/service';
import { PspError, type PSPAdapter, type VerifyResult } from '../src/services/payments/types';
import { makeApp, registerOwner, resetAll } from './helpers';

/**
 * Payment hardening, in the order it was fixed: MINOR, then MAJOR, then CRITICAL (docs/PAYMENTS.md has the risk register).
 * Every test here failed before its fix: a green run is not decoration.
 */

let app: FastifyInstance;
beforeAll(async () => { app = await makeApp(); });
afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });
beforeEach(async () => { await resetAll(); await redis.flushdb(); });
afterEach(() => vi.unstubAllGlobals());

const momo = { plan: 'growth' as const, interval: 'monthly' as const, method: 'mobile_money' as const, phone: '+237677000001' };

/** A controllable provider: what it answers to verify, how often it was asked, and whether starting a payment works. */
interface Fake extends PSPAdapter { verifyCalls: number; setVerify(v: VerifyResult | Error): void; initCalls: number }
function fake(name: string, opts: { initFails?: 'definite' | 'ambiguous' | 'rejected'; push?: boolean } = {}): Fake {
  let verify: VerifyResult | Error = { status: 'pending', amount: 0, currency: '' };
  const a: Fake = {
    name: name as never, push: opts.push, verifyCalls: 0, initCalls: 0,
    isConfigured: () => true,
    initiatePayment: async () => {
      a.initCalls++;
      if (opts.initFails === 'definite') throw new PspError('connection refused', name as never, true, false);
      if (opts.initFails === 'ambiguous') throw new PspError('timeout after sending', name as never, true, true);
      if (opts.initFails === 'rejected') throw new PspError('HTTP 401: invalid api key sk_live_secret', name as never, false, false);
      return { checkoutUrl: `https://pay.example/${name}`, pspReference: `${name}-ref` };
    },
    verifyPayment: async () => { a.verifyCalls++; if (verify instanceof Error) throw verify; return verify; },
    parseWebhook: async () => ({ signatureValid: true }),
    setVerify: (v) => { verify = v; },
  };
  return a;
}
const routerOf = (...a: PSPAdapter[]) => new PSPRouter([...a, { ...fake('mock'), isConfigured: () => false }]);
const planOf = async (userId: string) => (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).plan;
const txOf = (id: string) => prisma.paymentTransaction.findUniqueOrThrow({ where: { id } });
const quiet = { warn: () => undefined };

// ════════════════════════════════════════════════════════════════ MINOR ═══

describe('MINOR: what the customer sees and what we log', () => {
  it('m1 the browser gets a safe failure category, never the provider\'s own words', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay', { initFails: 'rejected' }));
    await expect(initiatePayment(o.userId, momo, router)).rejects.toMatchObject({ status: 502 });
    const row = await prisma.paymentTransaction.findFirstOrThrow({ where: { userId: o.userId } });
    expect(row.failReason).toMatch(/^psp_unavailable: .*invalid api key/); // the operator keeps the detail
    const listed = (await o.get('/api/payments')).items[0];
    expect(listed.failCode).toBe('unavailable');
    expect(JSON.stringify(listed)).not.toMatch(/api key|sk_live|failReason|notchpay HTTP/);
  });

  it('m1 a provider decline is "declined", anything else "other"', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    const tx = await initiatePayment(o.userId, momo, router);
    await settleTransaction(tx.id, { status: 'failed', amount: 0, currency: '' }, quiet);
    expect((await o.get('/api/payments')).items[0].failCode).toBe('declined');
  });

  it('m2 a browser polling every few seconds does not become a provider call each time; a webhook always verifies', async () => {
    const o = await registerOwner(app);
    const p = fake('notchpay');
    const router = routerOf(p);
    const tx = await initiatePayment(o.userId, momo, router);
    await Promise.all([refreshTransaction(tx, router), refreshTransaction(tx, router), refreshTransaction(tx, router)]);
    expect(p.verifyCalls).toBe(1);
    await refreshTransaction(tx, router, undefined, { force: true });
    await refreshTransaction(tx, router, undefined, { force: true });
    expect(p.verifyCalls).toBe(3); // a webhook is never skipped: the provider will not call again
  });

  it('m3 a provider whose verify endpoint is down is logged and flagged, and the payment stays pending', async () => {
    const o = await registerOwner(app);
    const p = fake('notchpay');
    const router = routerOf(p);
    const tx = await initiatePayment(o.userId, momo, router);
    p.setVerify(new Error('ECONNRESET'));
    const warn = vi.fn();
    const r = await refreshTransaction(tx, router, { warn }, { force: true });
    expect(r).toMatchObject({ outcome: 'pending', verifyError: true });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ txId: tx.id, psp: 'notchpay', err: 'ECONNRESET' }), expect.stringMatching(/verification failed/));
    expect((await txOf(tx.id)).status).toBe('pending');
  });

  it('m4 the Mobile Money number is validated and normalised against the owner\'s country', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    for (const bad of ['abc', '12345', '+237 111 111 111', '0000000000']) {
      await expect(initiatePayment(o.userId, { ...momo, phone: bad }, router), bad).rejects.toMatchObject({ status: 400, code: 'invalid_phone' });
    }
    expect(await prisma.paymentTransaction.count()).toBe(0);
    const tx = await initiatePayment(o.userId, { ...momo, phone: '677 12 34 56' }, router); // local format
    expect(tx.phone).toBe('+237677123456');
  });

  it('m4 a card payment needs no phone number', async () => {
    const o = await registerOwner(app);
    const tx = await initiatePayment(o.userId, { ...momo, method: 'card', phone: undefined }, routerOf(fake('flutterwave')));
    expect(tx.status).toBe('pending');
  });

  it('m5 an overpayment credits only what was asked, and a big one is logged for a human', async () => {
    const o = await registerOwner(app);
    const router = routerOf(fake('notchpay'));
    const tx = await initiatePayment(o.userId, momo, router);
    const warn = vi.fn();
    expect(await settleTransaction(tx.id, { status: 'success', amount: 39000 * 3, currency: 'XAF' }, { warn })).toBe('activated');
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/OVERPAID/));
    expect(await planOf(o.userId)).toBe('growth');

    const tx2 = await initiatePayment(o.userId, { ...momo, plan: 'business' }, router);
    const warn2 = vi.fn();
    await settleTransaction(tx2.id, { status: 'success', amount: Math.round(tx2.amount * 1.05), currency: 'XAF' }, { warn: warn2 }); // a buyer-side processing fee
    expect(warn2).not.toHaveBeenCalled();
  });
});
