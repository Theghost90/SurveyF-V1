import { z } from 'zod';

/**
 * zod 4 builds its object parsers with `new Function` when the environment allows it, and finds out by trying, the first time a schema is built. Under the website's
 * Content-Security-Policy (no 'unsafe-eval', on purpose) the browser refuses and REPORTS the attempt as a violation although zod catches the refusal and carries on:
 * a console error and a policy report on every page that loads these schemas, and the "the policy blocked nothing the product does" check of the browser run fails.
 * Browsers therefore get zod's plain parser; servers (which have no such policy) keep the fast one. The setting is read when a schema is built, so this module must be
 * imported before the first one: survey.ts imports it first.
 */
// Read through `globalThis`: this package is compiled without the DOM library, so the bare name `window` does not type-check here.
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') z.config({ jitless: true });
