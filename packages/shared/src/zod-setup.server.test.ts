import { describe, expect, it, vi } from 'vitest';

/** The other side: a server has no such policy, so zod keeps its fast, generated parsers there (the browser setting must not leak into the API). */
describe('zod on a server', () => {
  it('still probes for, and uses, generated parsers', async () => {
    const calls: unknown[][] = [];
    const Real = Function;
    vi.stubGlobal('Function', new Proxy(Real, { construct: (target, args) => { calls.push(args); return Reflect.construct(target, args); } }));
    try {
      const { optionSchema } = await import('./survey');
      expect(optionSchema.safeParse({ id: 'a-1', label: 'Yes' }).success).toBe(true);
      expect(calls.some((a) => a.length === 1 && a[0] === '')).toBe(true); // zod's `new Function('')` probe
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
