/**
 * The month inside a subscription period that the monthly limits (messages, responses) are counted over.
 *
 * A subscription period is one month for a monthly plan but twelve for an annual one, and an early renewal of the same plan extends it. The limits are written "per month",
 * yet they were counted over the WHOLE period: an annual customer's 1,000 messages "a month" were 1,000 for the year, and the responses beyond the allowance a year added up
 * against one month's worth. Counting by slices of one month, each starting where the previous one ended, fixes both, and gives overage billing (PAY-09) a window that
 * cannot be disputed: a month is a month, it is invoiced once, and an early renewal never changes a slice that is already over.
 */
export function addMonthsUTC(d: Date, n: number): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export interface Slice { start: Date; end: Date }

/** The slice of the period that `now` is in. Before the period starts: its first slice. After it ends: the last one. */
export function sliceAt(periodStart: Date, periodEnd: Date, now: Date): Slice {
  let k = 0;
  while (k < 400 && addMonthsUTC(periodStart, k + 1).getTime() <= now.getTime() && addMonthsUTC(periodStart, k + 1).getTime() < periodEnd.getTime()) k++;
  const start = addMonthsUTC(periodStart, k);
  const end = addMonthsUTC(periodStart, k + 1);
  return { start, end: end.getTime() > periodEnd.getTime() ? periodEnd : end };
}

/** Every slice of the period that is over by `now`, oldest first. */
export function completedSlices(periodStart: Date, periodEnd: Date, now: Date): Slice[] {
  const out: Slice[] = [];
  for (let k = 0; k < 400; k++) {
    const start = addMonthsUTC(periodStart, k);
    if (start.getTime() >= periodEnd.getTime()) break;
    const end = addMonthsUTC(periodStart, k + 1);
    const cut = end.getTime() > periodEnd.getTime() ? periodEnd : end;
    if (cut.getTime() > now.getTime()) break;
    out.push({ start, end: cut });
  }
  return out;
}
