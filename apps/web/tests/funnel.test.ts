import { describe, expect, it } from 'vitest';
import { worstStepIndex } from '@/components/analytics/funnel-view';

/** FUT-05: which step of the funnel is drawn in amber. It is a relative loss against the step before, so a small survey and a large one are read the same way. */
describe('the funnel step that lost the most people', () => {
  it('is the one with the largest share lost against the step before it, not the largest number', () => {
    expect(worstStepIndex([100, 90, 80, 20, 18])).toBe(3); // 20 of 80 left (75 %)
    expect(worstStepIndex([1000, 900, 450, 440])).toBe(2); // 50 % beats 10 %
    expect(worstStepIndex([10, 9, 3, 3])).toBe(2);
  });
  it('goes to the earlier step on a tie, and is -1 when nobody was lost or nobody came', () => {
    expect(worstStepIndex([100, 50, 25])).toBe(1);
    expect(worstStepIndex([5, 5, 5, 5])).toBe(-1);
    expect(worstStepIndex([0, 0, 0])).toBe(-1);
    expect(worstStepIndex([])).toBe(-1);
    expect(worstStepIndex([7])).toBe(-1);
  });
  it('never divides by a step nobody reached', () => {
    expect(worstStepIndex([10, 0, 0, 0])).toBe(1);
  });
});
