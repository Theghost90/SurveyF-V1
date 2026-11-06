/**
 * Writes apps/web/design-tokens.json from the Tailwind config and the stylesheet (DSN-02).   `npm run tokens`
 * With --check it only compares and exits 1 when the committed file is out of date (the web tests do the same).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const web = (p: string) => fileURLToPath(new URL(`../apps/web/${p}`, import.meta.url));
const { serializeTokens } = await import('../apps/web/src/design/tokens');
const next = serializeTokens(readFileSync(web('src/app/globals.css'), 'utf8'));
if (process.argv.includes('--check')) {
  const have = (() => { try { return readFileSync(web('design-tokens.json'), 'utf8'); } catch { return ''; } })();
  if (have !== next) { console.error('apps/web/design-tokens.json is out of date: run `npm run tokens`'); process.exit(1); }
  console.log('design-tokens.json is up to date');
} else {
  writeFileSync(web('design-tokens.json'), next);
  console.log('wrote apps/web/design-tokens.json');
}
