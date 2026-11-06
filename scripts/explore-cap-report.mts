/**
 * What the first weeks say about the free plan's cap on different people reached (BIZ-03). Aggregates only; a group of fewer than five owners is shown as "fewer than 5".
 *   npx tsx --env-file=.env scripts/explore-cap-report.mts [days]       default: the last 90 days
 */
const days = Number(process.argv[2] ?? 90);
const { capReport } = await import('../apps/api/src/services/cap-report');
const { prisma } = await import('../apps/api/src/lib/prisma');
const { redis } = await import('../apps/api/src/lib/redis');
const r = await capReport(new Date(), Number.isFinite(days) && days > 0 ? days : 90);
console.log(`The free plan's cap, since ${r.since.toISOString().slice(0, 10)}\n`);
console.log(`  owners who signed up                         ${r.exploreOwners}`);
console.log(`  owners stopped by the cap when sending       ${r.blockedOwners}`);
console.log(`  owners whose join link was refused by it     ${r.blockedByJoinLink}`);
console.log(`  paid within 7 days of being stopped          ${r.paidAfterBlocked7d}${r.paidAfterBlockedShare !== null ? ` (${r.paidAfterBlockedShare}% of the owners who were stopped)` : ''}`);
console.log(`  paid without ever being stopped              ${r.paidWithoutBlock}`);
console.log(`  stopped, not paid, more than 14 days ago     ${r.stuckAfterBlocked14d}`);
const x = r.reachedAtActivation;
console.log(`  people reached when they paid                ${typeof x === 'string' ? x : `median ${x.median} (middle half ${x.p25} to ${x.p75})`}`);
console.log('');
for (const n of r.notes) console.log(`  - ${n}`);
await prisma.$disconnect();
redis.disconnect();
