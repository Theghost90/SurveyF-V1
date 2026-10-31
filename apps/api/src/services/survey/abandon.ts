import { prisma } from '../../lib/prisma';
import { withLock } from '../../lib/redis';
import { dropSessionByKey, dueSessionKeys, loadSessionByKey, parseSessionKey, timeoutMs } from './sessions';

/**
 * 24h-inactivity sweeper (configurable via SESSION_TIMEOUT_HOURS).
 *
 * Redis keyspace expiry notifications are fire-and-forget (lost if the process is down), so the
 * deadline lives in a sorted set that is swept periodically instead. A second, SQL-based pass
 * covers the case where Redis itself was lost.
 */
export async function sweepAbandoned(now = Date.now()): Promise<number> {
  let abandoned = 0;

  for (const key of await dueSessionKeys(now)) {
    const { phoneNumberId, waId } = parseSessionKey(key);
    await withLock(`${phoneNumberId}:${waId}`, async () => {
      const s = await loadSessionByKey(key);
      if (!s) return dropSessionByKey(key);
      // The participant may have replied between the sorted-set read and now.
      if (new Date(s.lastInteractionAt).getTime() + timeoutMs() > now) return;
      const r = await prisma.surveyRecipient.updateMany({
        where: { id: s.recipientId, status: 'started' },
        data: { status: 'abandoned', abandonedAtQuestion: s.currentIndex + 1, abandonedAt: new Date(now) },
      });
      abandoned += r.count;
      await dropSessionByKey(key);
    }).catch(() => undefined);
  }

  // Redis-lost fallback: "started" for longer than the timeout, with no answer inside the window.
  const cutoff = new Date(now - timeoutMs());
  const stale = await prisma.surveyRecipient.findMany({
    where: { status: 'started', startedAt: { lt: cutoff } },
    select: { id: true, surveyId: true, contactId: true },
    take: 200,
  });
  for (const r of stale) {
    const latest = await prisma.response.findFirst({ where: { surveyId: r.surveyId, contactId: r.contactId }, orderBy: { answeredAt: 'desc' }, select: { answeredAt: true } });
    if (latest && latest.answeredAt > cutoff) continue;
    const answered = await prisma.response.count({ where: { surveyId: r.surveyId, contactId: r.contactId } });
    const upd = await prisma.surveyRecipient.updateMany({ where: { id: r.id, status: 'started' }, data: { status: 'abandoned', abandonedAtQuestion: answered + 1, abandonedAt: new Date(now) } });
    abandoned += upd.count;
  }
  return abandoned;
}
