import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Recharts 2 recognises its children (axes, bars, labels) with `react-is`. With React 19 and a `react-is` of an older major, the page still renders but without its axes and
 * with most bars missing: the per-question charts of the analytics page looked empty on a real screen while every other check was green. The root package.json pins
 * `react-is` (an override) to React's own version; this test fails if a future install brings the old one back.
 */
describe('chart dependencies', () => {
  const major = (v: string) => Number(v.split('.')[0]);
  const here = createRequire(import.meta.url);
  const reactMajor = major(here('react/package.json').version as string);

  it('recharts resolves the same react-is major as React', () => {
    const fromRecharts = createRequire(here.resolve('recharts'));
    expect(major(fromRecharts('react-is/package.json').version as string)).toBe(reactMajor);
  });

  it('no other copy of react-is that a chart library could pick up is of an older major', () => {
    expect(major(here('react-is/package.json').version as string)).toBe(reactMajor);
  });
});
