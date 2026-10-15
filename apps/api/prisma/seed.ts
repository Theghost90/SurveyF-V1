/**
 * Demo data for local preview. NEVER runs in production.
 *   npm run db:seed        → account demo@surveyflow.test / demo-password-123 (Growth plan, simulated WhatsApp number)
 *
 * Everything here is fabricated for the demo (names, numbers, answers). Phone numbers use a reserved-looking
 * pattern and are never contacted: the WhatsApp gateway in demo mode only writes to a local outbox.
 */
import bcrypt from 'bcryptjs';
import { TEMPLATE_DEFS, giftFee } from '@surveyflow/shared';
import { env } from '../src/config/env';
import { encryptSecret } from '../src/lib/crypto';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { saveSession } from '../src/services/survey/sessions';

if (env.isProd) {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

// Small deterministic PRNG so the demo looks the same every time.
let s = 20261013;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const chance = (p: number) => rnd() < p;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const FIRST = ['Marie', 'Paul', 'Aïcha', 'Jean', 'Fatima', 'Éric', 'Sandrine', 'Brice', 'Nadège', 'Hervé', 'Christelle', 'Patrick', 'Mireille', 'Serge', 'Estelle', 'Landry', 'Clarisse', 'Boris', 'Larissa', 'Yannick'];
const LAST = ['N.', 'K.', 'M.', 'T.', 'B.', 'E.', 'F.', 'S.', 'A.', 'D.'];
const SUGGESTIONS = [
  'Faster delivery please', 'More payment options', 'Great service!', 'Lower prices', 'Open earlier in the morning',
  'Please add Orange Money', 'Staff are very friendly', 'More choice of bread', 'Delivery before 8am please', 'Keep the quality up',
  'Sometimes the shop is too crowded', 'Can you deliver to Bonamoussadi?', 'Loyalty card would be nice', 'Prices went up too fast', 'Thank you!',
];

async function main() {
  const email = 'demo@surveyflow.test';
  await prisma.user.deleteMany({ where: { email } });

  const now = new Date();
  const user = await prisma.user.create({
    data: {
      email, passwordHash: await bcrypt.hash('demo-password-123', 12), name: 'Jean-Paul Nkou', businessName: 'Boulangerie Akwa',
      phone: '+237677000000', plan: 'growth', country: 'CM', locale: 'en', preferredCurrency: 'XAF', segment: 'business', onboardingDoneAt: now,
      subscription: { create: { plan: 'growth', status: 'active', currentPeriodStart: hoursAgo(24 * 10), currentPeriodEnd: new Date(now.getTime() + 20 * 86_400_000), amountFCFA: 39_000, paymentMethod: 'mobile_money', pspProvider: 'mock', interval: 'monthly' } },
    },
  });
  const account = await prisma.whatsAppAccount.create({
    data: { userId: user.id, wabaId: 'mock-waba-demo', phoneNumberId: 'mock-demo000001', displayPhone: '+237 600 00 00 00 (simulated)', accessToken: encryptSecret('mock-token-for-local-development'), status: 'active' },
  });
  await prisma.messageTemplate.createMany({ data: TEMPLATE_DEFS.map((d) => ({ accountId: account.id, name: d.name, language: d.language, category: d.category, status: 'APPROVED' })) });

  // ---- contacts ----------------------------------------------------------------------------
  const contacts = [] as Array<{ id: string }>;
  for (let i = 0; i < 60; i++) {
    const c = await prisma.contact.create({
      data: {
        userId: user.id, name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`, phone: `+2376771000${String(i).padStart(2, '0')}`,
        tags: i % 5 === 0 ? ['vip'] : i % 3 === 0 ? ['douala'] : [], consentAt: hoursAgo(24 * 20), consentSource: 'owner_csv_import', createdAt: hoursAgo(24 * 20),
      },
    });
    contacts.push(c);
  }

  // ---- survey 1: active, populated ------------------------------------------------------------------
  const survey = await prisma.survey.create({
    data: {
      userId: user.id, whatsappAccountId: account.id, title: 'Customer Satisfaction — October 2026', description: 'Demo survey', language: 'en', status: 'active', publishedAt: hoursAgo(24 * 6),
      giftType: 'airtime', giftValue: '500 FCFA airtime', giftAmount: 500, giftDeliveryMode: 'immediate', giftMaxCount: 200,
      questions: {
        create: [
          { order: 0, text: 'How satisfied are you with our service?', type: 'button', required: true, options: [{ id: 'vs', label: 'Very satisfied' }, { id: 'ne', label: 'Neutral' }, { id: 'un', label: 'Unsatisfied' }] },
          { order: 1, text: 'Which product do you use most?', type: 'list', required: true, options: ['Baguette', 'Croissant', 'Pain au chocolat', 'Cake', 'Pizza', 'Other'].map((label, i) => ({ id: `p${i}`, label })) },
          { order: 2, text: 'Any suggestions for improvement?', type: 'text', required: false },
        ],
      },
    },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  const [q1, q2, q3] = survey.questions as [typeof survey.questions[number], typeof survey.questions[number], typeof survey.questions[number]];
  const opts = (q: typeof q1) => (q.options as Array<{ label: string }>).map((o) => o.label);

  // outcome per contact
  type Outcome = 'completed' | 'abandoned2' | 'abandoned3' | 'declined' | 'started' | 'delivered';
  const plan: Outcome[] = [...Array(35).fill('completed'), ...Array(5).fill('abandoned2'), ...Array(3).fill('abandoned3'), ...Array(5).fill('declined'), ...Array(4).fill('started'), ...Array(8).fill('delivered')];
  plan.sort(() => rnd() - 0.5);
  let giftN = 0;
  const FEE = giftFee(500, env.GIFT_FEE_PERCENT);
  const giftEvents: Array<{ id: string; at: Date; refund: boolean }> = [];

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]!;
    const outcome = plan[i]!;
    const sentAt = hoursAgo(24 * 6 - rnd() * 6);
    // "started" participants are mid-conversation right now (a real one has a live Redis session); everyone else started days ago.
    const startedAt = outcome === 'started' ? hoursAgo(0.2 + rnd() * 3) : new Date(sentAt.getTime() + (5 + rnd() * 600) * 60_000 + Math.floor(rnd() * 5) * 86_400_000 * 0.4);
    const rec = await prisma.surveyRecipient.create({
      data: { surveyId: survey.id, contactId: c.id, status: outcome === 'completed' ? 'completed' : outcome === 'abandoned2' || outcome === 'abandoned3' ? 'abandoned' : outcome, sentAt, createdAt: sentAt, waMessageId: `wamid.DEMO${i}` },
    });
    await prisma.messageLog.create({ data: { userId: user.id, kind: 'invitation', waMessageId: rec.waMessageId, createdAt: sentAt } });
    if (outcome === 'declined' || outcome === 'delivered') continue;

    const answers: Array<[string, string]> = [];
    const v = rnd();
    answers.push([q1.id, v < 0.58 ? 'Very satisfied' : v < 0.85 ? 'Neutral' : 'Unsatisfied']);
    if (outcome !== 'started') answers.push([q2.id, pick(opts(q2).slice(0, 5).concat(['Baguette', 'Baguette', 'Croissant']))]);
    if (outcome === 'abandoned2') answers.pop();
    if (outcome === 'completed' || outcome === 'abandoned3') {
      if (outcome === 'completed' && chance(0.7)) answers.push([q3.id, pick(SUGGESTIONS)]);
      if (outcome === 'completed' && !answers.some(([q]) => q === q3.id)) answers.push([q3.id, '']);
    }
    if (outcome === 'started') answers.length = 0;
    if (outcome === 'started') await saveSession(account.phoneNumberId, `2376771000${String(i).padStart(2, '0')}`, { surveyId: survey.id, contactId: c.id, recipientId: rec.id, phoneNumberId: account.phoneNumberId, currentIndex: 0, startedAt: startedAt.toISOString(), lastInteractionAt: startedAt.toISOString() });
    const completedAt = new Date(startedAt.getTime() + (45 + rnd() * 240) * 1000);
    await prisma.surveyRecipient.update({
      where: { id: rec.id },
      data: { startedAt, ...(outcome === 'completed' ? { completedAt } : {}), ...(outcome === 'abandoned2' ? { abandonedAtQuestion: 2 } : outcome === 'abandoned3' ? { abandonedAtQuestion: 3 } : {}) },
    });
    for (const [qid, answer] of answers) {
      await prisma.response.create({ data: { surveyId: survey.id, contactId: c.id, questionId: qid, answer, answeredAt: new Date(startedAt.getTime() + 30_000) } });
    }
    if (outcome === 'completed') {
      giftN++;
      const g = await prisma.giftDelivery.create({
        data: { surveyId: survey.id, contactId: c.id, giftType: 'airtime', giftValue: '500 FCFA airtime', amount: 500, fee: FEE, payoutXAF: 500, refundedAt: giftN === 7 ? new Date(completedAt.getTime() + 75 * 60_000) : null, status: giftN === 7 ? 'failed' : giftN > 32 ? 'pending' : 'sent', sentAt: giftN > 32 || giftN === 7 ? null : completedAt, errorMessage: giftN === 7 ? 'provider declined: number not eligible' : null, attempts: giftN === 7 ? 3 : 0, scheduledFor: giftN > 32 ? new Date(Date.now() + 3_600_000) : completedAt, createdAt: completedAt, providerRef: giftN <= 32 && giftN !== 7 ? `mock-airtime-${giftN}` : null },
      });
      giftEvents.push({ id: g.id, at: completedAt, refund: giftN === 7 });
    }
  }

  // ---- gift wallet: top-up, one debit per completed participant, refund for the definitively failed gift ----------------
  // Built from the same ledger rules the API uses, so balance == sum(ledger) holds in the demo too.
  const topupAt = hoursAgo(24 * 6.5);
  const topupRef = 'sfdemotopup00000000001';
  const subRow = await prisma.subscription.findUniqueOrThrow({ where: { userId: user.id } });
  await prisma.paymentTransaction.create({ data: { subscriptionId: subRow.id, userId: user.id, pspProvider: 'mock', amount: 50_000, currency: 'XAF', status: 'success', reference: topupRef, purpose: 'gift_topup', plan: null, interval: 'monthly', method: 'mobile_money', paidAt: topupAt, createdAt: topupAt } });
  type Ev = { at: Date; delta: number; kind: string; refId: string; note: string };
  const events: Ev[] = [{ at: topupAt, delta: 50_000, kind: 'topup', refId: topupRef, note: 'Top-up (mock Mobile Money)' }];
  for (const e of giftEvents) {
    events.push({ at: e.at, delta: -(500 + FEE), kind: 'gift_debit', refId: e.id, note: 'Gift — Customer Satisfaction — October 2026' });
    if (e.refund) events.push({ at: new Date(e.at.getTime() + 75 * 60_000), delta: 500 + FEE, kind: 'gift_refund', refId: e.id, note: 'Gift could not be delivered — refunded' });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  let balance = 0;
  for (const e of events) {
    balance += e.delta;
    await prisma.walletEntry.create({ data: { userId: user.id, delta: e.delta, balanceAfter: balance, kind: e.kind, refId: e.refId, note: e.note, createdAt: e.at } });
  }
  await prisma.user.update({ where: { id: user.id }, data: { giftBalance: balance, giftCurrency: 'XAF' } }); // a wallet that holds money has its currency fixed

  // ---- survey 2: draft ----------------------------------------------------------------------------------
  await prisma.survey.create({
    data: {
      userId: user.id, whatsappAccountId: account.id, title: 'Nouveau menu — avis clients', language: 'fr', status: 'draft',
      questions: { create: [{ order: 0, text: 'Que pensez-vous de notre nouveau menu ?', type: 'rating', required: true, options: [1, 2, 3, 4, 5].map((n) => ({ id: String(n), label: String(n) })) }, { order: 1, text: 'Un commentaire ?', type: 'text', required: false }] },
    },
  });

  // a successful past payment for the invoice list
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: user.id } });
  await prisma.paymentTransaction.create({ data: { subscriptionId: sub.id, userId: user.id, pspProvider: 'mock', amount: 39_000, currency: 'XAF', status: 'success', reference: 'sfdemoinvoice00000001', plan: 'growth', interval: 'monthly', method: 'mobile_money', paidAt: hoursAgo(24 * 10), createdAt: hoursAgo(24 * 10) } });

  console.log('\nSeeded demo data.\n  Email:    demo@surveyflow.test\n  Password: demo-password-123\n  Plan:     Growth (simulated WhatsApp number, mock gifts, mock checkout)\n');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); redis.disconnect(); });
