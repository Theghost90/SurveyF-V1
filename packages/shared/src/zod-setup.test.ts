import { describe, expect, it, vi } from 'vitest';

/**
 * Found by the browser run on the production build: zod 4 probes for `eval` (`new Function('')`) when it builds its first object schema, and a Content-Security-Policy without
 * 'unsafe-eval' reports that as a violation although zod copes. In a browser the shared schemas must be built without ever constructing a Function.
 * (zod is loaded once per test file, so the server's side of this is in zod-setup.server.test.ts.)
 */
describe('zod in a browser, under a Content-Security-Policy that forbids eval', () => {
  it('building the shared schemas constructs no Function: nothing for the policy to report; and they still parse', async () => {
    const calls: unknown[][] = [];
    const Real = Function;
    vi.stubGlobal('Function', new Proxy(Real, { construct: (target, args) => { calls.push(args); return Reflect.construct(target, args); } }));
    vi.stubGlobal('window', {});
    try {
      const { optionSchema } = await import('./survey');
      expect(calls).toEqual([]);
      expect(optionSchema.safeParse({ id: 'a-1', label: ' Yes ' })).toMatchObject({ success: true, data: { id: 'a-1', label: 'Yes' } });
      expect(optionSchema.safeParse({ id: 'not url safe!', label: '' }).success).toBe(false);
      expect(calls).toEqual([]); // parsing did not build one either
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
