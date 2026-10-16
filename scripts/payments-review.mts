/**
 * Payments an operator has to decide on. A payment lands in `review` when the provider CONFIRMED the money but SurveyFlow could not simply apply it:
 * underpaid, paid in another currency, a lower plan than the one now active, or an activation that failed. The customer was told once that we are
 * checking; the API logged it as PAYMENT_REVIEW. Nothing here talks to a payment provider: it only reads our own database and applies your decision.
 *
 *   npx tsx --env-file=.env scripts/payments-review.mts list [review|pending|unconfirmed]     default: review
 *   npx tsx --env-file=.env scripts/payments-review.mts show <reference|id>                  one payment in full, with every provider we tried
 *   npx tsx --env-file=.env scripts/payments-review.mts credit <reference|id> --note "why"   apply it as paid (the amount we ASKED is credited)
 *   npx tsx --env-file=.env scripts/payments-review.mts reject <reference|id> --note "why"   close it as failed; the customer is told it will be returned
 *
 * `credit` and `reject` only work on a payment in `review`, once, and need a note (it is kept on the payment). Refunding money at the provider is done in
 * the provider's dashboard: `reject` does not move money. See docs/PAYMENTS.md.
 */
const args = process.argv.slice(2);
const [cmd = 'list', target] = args;
const note = (() => { const i = args.indexOf('--note'); return i >= 0 ? args[i + 1] : undefined; })();

const { prisma } = await import('../apps/api/src/lib/prisma');
const { redis } = await import('../apps/api/src/lib/redis');
const { listReview, resolveReview } = await import('../apps/api/src/services/payments/settlement');

const age = (d: Date) => { const m = Math.round((Date.now() - d.getTime()) / 60_000); return m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const row = (t: { reference: string; createdAt: Date; amount: number; currency: string; pspProvider: string; purpose: string; plan: string | null; failReason: string | null; user?: { email: string; phone: string | null } | null }) =>
  `${t.reference}  ${age(t.createdAt).padStart(6)} ago  ${`${t.amount} ${t.currency}`.padEnd(12)} ${t.pspProvider.padEnd(11)} ${(t.purpose === 'gift_topup' ? 'wallet top-up' : t.plan ?? '').padEnd(13)} ${t.user?.email ?? ''} ${t.user?.phone ?? ''}\n    ${t.failReason ?? ''}`;

async function find(ref: string) {
  const t = await prisma.paymentTransaction.findFirst({ where: { OR: [{ reference: ref }, { id: ref }] }, include: { user: { select: { email: true, name: true, phone: true } } } });
  if (!t) { console.error(`No payment with reference or id "${ref}".`); process.exitCode = 1; }
  return t;
}

try {
  if (cmd === 'list') {
    const which = target ?? 'review';
    const rows = which === 'review' ? await listReview()
      : await prisma.paymentTransaction.findMany({
        where: which === 'unconfirmed' ? { status: 'pending', failReason: { startsWith: 'unconfirmed' } } : { status: 'pending', createdAt: { lt: new Date(Date.now() - 2 * 3_600_000) } },
        orderBy: { createdAt: 'asc' }, include: { user: { select: { email: true, name: true, phone: true } } },
      });
    console.log(rows.length ? rows.map(row).join('\n') : `Nothing in "${which}".`);
    if (which === 'pending') console.log('\n(pending for over two hours: the reconciliation job asks the provider about each of these; an unconfirmed Campay start with no provider reference can only be settled by its webhook or found in the Campay dashboard by this reference)');
  } else if (cmd === 'show' && target) {
    const t = await find(target);
    if (t) console.log(JSON.stringify(t, null, 2));
  } else if ((cmd === 'credit' || cmd === 'reject') && target) {
    if (!note) { console.error(`--note "why" is required: it is kept on the payment.`); process.exitCode = 1; }
    else {
      const t = await find(target);
      if (t) {
        const r = await resolveReview(t.id, cmd, note);
        console.log(r === 'not_in_review' ? `${t.reference} is "${t.status}", not "review": nothing done.` : `${t.reference}: ${r}.`);
        if (r === 'not_in_review') process.exitCode = 1;
      }
    }
  } else {
    console.error('Usage: payments-review.mts list [review|pending|unconfirmed] | show <ref> | credit <ref> --note "…" | reject <ref> --note "…"');
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
  redis.disconnect();
}
