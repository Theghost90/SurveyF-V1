import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { retryOnDeadlock } from './helpers';

afterAll(async () => { await prisma.$disconnect(); redis.disconnect(); });

/** What Prisma throws when Postgres picks a raw statement as the victim of a deadlock (found in a full run: the next test's reset died with this). */
const deadlock = () => new Error('Invalid `prisma.$executeRawUnsafe()` invocation:\n\nRaw query failed. Code: `40P01`. Message: `deadlock detected`');

describe('the reset every test starts with runs again when Postgres picks it as the victim of a deadlock', () => {
  it('a statement that deadlocks once is run again and its answer is returned', async () => {
    let calls = 0;
    const answer = await retryOnDeadlock(async () => { if (++calls === 1) throw deadlock(); return 'done'; });
    expect(answer).toBe('done');
    expect(calls).toBe(2);
  });

  it('gives up after five tries: a deadlock that does not go away is a real problem', async () => {
    let calls = 0;
    await expect(retryOnDeadlock(async () => { calls++; throw deadlock(); })).rejects.toThrow(/deadlock detected/);
    expect(calls).toBe(5);
  });

  it('retries nothing else: any other failure is thrown at once', async () => {
    let calls = 0;
    await expect(retryOnDeadlock(async () => { calls++; throw new Error('Raw query failed. Code: `42P01`. Message: `relation "Nope" does not exist`'); })).rejects.toThrow(/42P01/);
    expect(calls).toBe(1);
  });
});
