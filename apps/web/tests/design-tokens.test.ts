import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTokens, rootVariables, serializeTokens } from '../src/design/tokens';

/**
 * DSN-02: the exported design tokens are the product's own. Containment: they are generated, never typed, and a test fails when the committed file has drifted from the
 * configuration (so a designer is never handed colours the product no longer uses).
 */
const css = readFileSync(path.join(__dirname, '../src/app/globals.css'), 'utf8');

describe('design tokens', () => {
  it('the committed file is exactly what the configuration produces (run `npm run tokens` after changing the palette)', () => {
    const committed = readFileSync(path.join(__dirname, '../design-tokens.json'), 'utf8');
    expect(committed).toBe(serializeTokens(css));
  });

  it('every colour is a six-digit hex value', () => {
    const walk = (n: any, out: string[] = []): string[] => { if (n && typeof n === 'object') { if (n.$type === 'color') out.push(n.$value); else Object.values(n).forEach((c) => walk(c, out)); } return out; };
    const colors = walk(buildTokens(css).color);
    expect(colors.length).toBeGreaterThan(20);
    for (const c of colors) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('the semantic names carry the value of their CSS variable, converted, and sit within rounding of the palette colour they stand for', () => {
    const t = buildTokens(css).color as any;
    const near = (a: string, b: string) => [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 2); // the variables are whole-number HSL: a unit of rounding
    expect(near(t.background.$value, t.canvas.$value)).toBe(true);
    expect(near(t.foreground.$value, t.ink.default.$value)).toBe(true);
    expect(near(t.border.$value, t.line.default.$value)).toBe(true);
    expect(t.background.$description).toBe('semantic: var(--background)');
  });

  it('reads the variables of the first :root block, ignoring comments', () => {
    expect(rootVariables(':root { --a: 1 2% 3%; /* x */ --b: 0.5rem; }')).toEqual({ a: '1 2% 3%', b: '0.5rem' });
  });

  it('carries the fonts, the radius and the shadows too', () => {
    const t = buildTokens(css) as any;
    expect(t.fontFamily.display.$value[0]).toContain('Bricolage');
    expect(t.radius.base.$value).toBe('0.75rem');
    expect(Object.keys(t.shadow).sort()).toEqual(['card', 'float', 'phone']);
  });
});
