/**
 * The daily reconciliation, by hand (PAY-02): do the wallets add up, and do the payment providers hold what customers are owed? This changes nothing at any provider
 * and nothing in a wallet: it reads our own database, records what you type, and says what it finds. The same check runs by itself once a day (jobs/scheduler).
 *
 *   npx tsx --env-file=.env scripts/reconcile.mts status [--fetch]        run the check now; --fetch also reads the providers named in BALANCE_SOURCES
 *   npx tsx --env-file=.env scripts/reconcile.mts balance <provider> <amount> [--currency XAF] [--note "dashboard, 09:10"]
 *                                                                          record what a provider's dashboard says the merchant account holds (available balance)
 *   npx tsx --env-file=.env scripts/reconcile.mts history [n]             the last runs (default 10)
 *
 * The routine until the automatic reading is verified against your providers: each morning, open each provider's dashboard, type its available balance with `balance`,
 * then run `status`. A balance older than RECONCILE_BALANCE_MAX_AGE_HOURS (48) is not used, and the check says so instead of guessing. Exit code 1 when something needs a person.
 */
const args = process.argv.slice(2);
const [cmd = 'status', a, b] = args;
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const { prisma } = await import('../apps/api/src/lib/prisma');
const { redis } = await import('../apps/api/src/lib/redis');
const { recordBalance, runReconciliation } = await import('../apps/api/src/services/reconciliation');

const fmt = (v: number | null) => (v === null ? 'n/a' : `${v.toLocaleString('en')} XAF`);
try {
  if (cmd === 'balance' && a && b) {
    const amount = Number(b.replace(/[ ,_]/g, ''));
    if (!Number.isFinite(amount) || amount < 0) { console.error(`"${b}" is not an amount (a number of zero or more, available balance).`); process.exitCode = 2; }
    else {
      const row = await recordBalance({ provider: a, currency: opt('currency') ?? 'XAF', available: amount, source: 'manual', note: opt('note') });
      console.log(`recorded: ${row.provider} ${row.available} ${row.currency} as of ${row.asOf.toISOString()}`);
    }
  } else if (cmd === 'status') {
    const r = await runReconciliation({ source: 'cli', fetchBalances: args.includes('--fetch') });
    console.log(`Owed to customers : ${fmt(r.obligationsXAF)}`);
    for (const w of r.wallets) console.log(`  wallets           ${String(w.amount).padStart(12)} ${w.currency}${w.xaf === null ? '  (no rate: not counted)' : ''}`);
    for (const w of r.payoutsInFlight) console.log(`  payouts in flight ${String(w.amount).padStart(12)} ${w.currency}${w.xaf === null ? '  (no rate: not counted)' : ''}`);
    console.log(`Held by providers : ${r.assetsXAF === null ? 'not compared (see below)' : fmt(r.assetsXAF)}`);
    for (const p of r.providers) console.log(`  ${p.provider.padEnd(12)} ${String(p.available).padStart(12)} ${p.currency}  ${p.fresh ? 'fresh' : 'STALE'} (${p.source}, ${p.ageHours} h old)`);
    if (r.shortfallXAF !== null) console.log(`Difference        : ${r.shortfallXAF > 0 ? `${fmt(r.shortfallXAF)} SHORT` : `${fmt(-r.shortfallXAF)} more than owed`}`);
    console.log('');
    if (!r.findings.length) console.log('No findings.');
    for (const f of r.findings) console.log(`${f.severity === 'alert' ? '✗' : '–'} ${f.code}: ${f.message}`);
    console.log(r.ok ? '\nOK: nothing needs a person.' : '\nNEEDS A PERSON: see the ✗ lines. Nothing was changed.');
    if (!r.ok) process.exitCode = 1;
  } else if (cmd === 'history') {
    const rows = await prisma.reconciliationRun.findMany({ orderBy: { at: 'desc' }, take: Number(a ?? 10) });
    console.log(rows.length ? rows.map((x) => `${x.at.toISOString()}  ${x.ok ? 'ok   ' : 'ALERT'}  ${x.source.padEnd(3)}  owed ${fmt(x.obligationsXAF)}  held ${fmt(x.assetsXAF)}  ${(x.findings as Array<{ code: string }>).map((f) => f.code).join(',')}`).join('\n') : 'No run yet.');
  } else {
    console.error('Usage: reconcile.mts status [--fetch] | balance <provider> <amount> [--currency XAF] [--note "…"] | history [n]');
    process.exitCode = 2;
  }
} finally {
  await prisma.$disconnect();
  redis.disconnect();
}
