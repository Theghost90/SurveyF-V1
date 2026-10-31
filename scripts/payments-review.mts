/**
 * The money that needs a person (PAY-07): payments the provider confirmed but SurveyFlow could not simply apply, and gifts whose payout nobody can vouch for.
 * Nothing here talks to a payment provider: it reads our own database and applies your decision. Look at the provider's own records first, then decide.
 *
 *   npx tsx --env-file=.env scripts/payments-review.mts list [review|pending|unconfirmed]     default: review
 *   npx tsx --env-file=.env scripts/payments-review.mts show <reference|id>                  one payment in full, with every provider we tried
 *   npx tsx --env-file=.env scripts/payments-review.mts credit|reject <reference|id> --operator <you> --note "why" [--yes]
 *   npx tsx --env-file=.env scripts/payments-review.mts gifts                                gifts only a person can settle: unknown outcome, or held for good by a limit
 *   npx tsx --env-file=.env scripts/payments-review.mts gift show <id> [--reveal --operator <you> --note "why"]
 *   npx tsx --env-file=.env scripts/payments-review.mts gift sent    <id> --operator <you> --note "why" --evidence <the provider's reference for the payout> [--yes]
 *   npx tsx --env-file=.env scripts/payments-review.mts gift refund  <id> --operator <you> --note "why" [--yes]      the provider did NOT pay: the ledger's amount goes back to the wallet
 *   npx tsx --env-file=.env scripts/payments-review.mts gift release <id> --operator <you> --note "why" [--yes]      let a held gift out whatever the limits say
 *   npx tsx --env-file=.env scripts/payments-review.mts gift cancel  <id> --operator <you> --note "why" [--yes]      drop a held gift (never debited, nothing to give back)
 *
 * Every decision needs who (--operator) and why (--note) and is recorded; without --yes it only shows what it WOULD do. The amounts come from the ledger, never from
 * what is typed, and a decision applies once. Participants' numbers are masked unless you ask (--reveal, recorded). `credit` applies a payment as paid (the amount we
 * ASKED is credited); `reject` closes it as failed and tells the customer it will be returned: refunding money AT the provider is done in the provider's dashboard.
 * There is no staff login behind --operator: it is a name you type, and the credential is your access to the database (docs/DECISIONS.md section 3.14).
 */
const args = process.argv.slice(2);
const [cmd = 'list', target, third] = args;
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const yes = args.includes('--yes');
const decision = () => ({ operator: opt('operator') ?? '', note: opt('note') ?? '', evidence: opt('evidence') });

const { prisma } = await import('../apps/api/src/lib/prisma');
const { redis } = await import('../apps/api/src/lib/redis');
const { listReview } = await import('../apps/api/src/services/payments/settlement');
const { describeGiftDecision, giftsToVerify, resolveGift, resolvePayment, revealGiftNumber } = await import('../apps/api/src/services/money-resolution');

const age = (d: Date) => { const m = Math.round((Date.now() - d.getTime()) / 60_000); return m < 120 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const row = (t: { reference: string; createdAt: Date; amount: number; currency: string; pspProvider: string; purpose: string; plan: string | null; failReason: string | null; user?: { email: string; phone: string | null } | null }) =>
  `${t.reference}  ${age(t.createdAt).padStart(6)} ago  ${`${t.amount} ${t.currency}`.padEnd(12)} ${t.pspProvider.padEnd(11)} ${(t.purpose === 'gift_topup' ? 'wallet top-up' : t.plan ?? '').padEnd(13)} ${t.user?.email ?? ''} ${t.user?.phone ?? ''}\n    ${t.failReason ?? ''}`;

async function find(ref: string) {
  const t = await prisma.paymentTransaction.findFirst({ where: { OR: [{ reference: ref }, { id: ref }] }, include: { user: { select: { email: true, name: true, phone: true } } } });
  if (!t) { console.error(`No payment with reference or id "${ref}".`); process.exitCode = 1; }
  return t;
}
const preview = (what: string) => { console.log(`WOULD: ${what}\nNothing was done. Add --yes to do it.`); };
const fail = (m: string) => { console.error(m); process.exitCode = 1; };

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
    const t = await find(target);
    if (t) {
      if (t.status !== 'review') fail(`${t.reference} is "${t.status}", not "review": nothing done.`);
      else if (!yes) {
        if (!decision().operator || !decision().note) fail('--operator <you> and --note "why" are required.');
        else preview(cmd === 'credit' ? `credit ${t.reference} (${t.amount} ${t.currency}, ${t.user?.email}) as PAID: the amount we asked is applied, whatever the provider collected.` : `reject ${t.reference} (${t.amount} ${t.currency}, ${t.user?.email}): close it as failed and tell the customer the money will be returned (you refund it at the provider).`);
      } else {
        const r = await resolvePayment(t.id, cmd, decision());
        console.log(r === 'not_in_review' ? `${t.reference} is no longer in review: nothing done.` : `${t.reference}: ${r}. Recorded.`);
        if (r === 'not_in_review') process.exitCode = 1;
      }
    }
  } else if (cmd === 'gifts') {
    const rows = await giftsToVerify();
    console.log(rows.length ? rows.map((g) => `${g.id}  ${age(g.createdAt).padStart(6)} ago  ${String(g.amount).padStart(7)} ${g.currency} ${g.type.padEnd(7)} ${g.phone.padEnd(14)} ${g.why === 'unknown_outcome' ? 'UNKNOWN OUTCOME' : 'HELD FOR GOOD  '} ${g.owner}\n    ${g.error ?? ''}  (provider ref ${g.providerRef ?? '-'}, ledger holds ${g.inLedger} ${g.currency})`).join('\n') : 'No gift needs a person.');
  } else if (cmd === 'gift' && target === 'show' && third) {
    const g = (await giftsToVerify()).find((x) => x.id === third);
    if (!g) fail(`Gift ${third} is not one that needs a person (unknown outcome, or held for good).`);
    else {
      console.log(JSON.stringify(g, null, 2));
      if (args.includes('--reveal')) {
        const phone = await revealGiftNumber(g.id, decision()).catch((e: Error) => { fail(e.message); return null; });
        if (phone) console.log(`number: ${phone}   (recorded)`);
      } else console.log('(the number is masked; --reveal --operator <you> --note "why" shows it and records that you did)');
    }
  } else if (cmd === 'gift' && ['sent', 'refund', 'release', 'cancel'].includes(target ?? '') && third) {
    const kind = target as 'sent' | 'refund' | 'release' | 'cancel';
    const g = (await giftsToVerify()).find((x) => x.id === third);
    const wrong = !g ? 'is not one that needs a person' : (kind === 'sent' || kind === 'refund') && g.why !== 'unknown_outcome' ? 'is held, not an unknown outcome: use release or cancel' : (kind === 'release' || kind === 'cancel') && g.why !== 'held_for_good' ? 'is an unknown outcome, not held: use sent or refund' : null;
    if (wrong) fail(`Gift ${third} ${wrong}.`);
    else if (!decision().operator || !decision().note) fail('--operator <you> and --note "why" are required.');
    else if (kind === 'sent' && !decision().evidence) fail("saying the provider paid needs the provider's own reference for that payout: --evidence <reference>.");
    else if (!yes) { console.log(`Gift ${g!.id}: ${g!.amount} ${g!.currency} ${g!.type} to ${g!.phone}, owner ${g!.owner}, "${g!.survey}"\n  ${g!.error ?? ''}`); preview(describeGiftDecision(g!, kind)); }
    else {
      const r = await resolveGift(g!.id, kind, decision());
      console.log(r === 'done' ? `Gift ${g!.id}: ${kind} done. Recorded.` : r === 'insufficient' ? `Gift ${g!.id}: allowed out, but the owner's wallet cannot pay it: it is now waiting for funds.` : `Gift ${g!.id}: nothing done (it was already resolved).`);
      if (r === 'not_resolvable') process.exitCode = 1;
    }
  } else {
    console.error('Usage: payments-review.mts list | show <ref> | credit|reject <ref> --operator … --note … [--yes] | gifts | gift show <id> | gift sent|refund|release|cancel <id> --operator … --note … [--evidence …] [--yes]');
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
  redis.disconnect();
}
