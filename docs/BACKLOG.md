# SurveyFlow backlog

The living list of what SurveyFlow V1 needs and where each item stands. **Section A is what is built; sections B and C are what is not built yet.** Every item has an ID (SEC-07, PAY-13 and so on), a MoSCoW class (Must, Should, Could, Won't this release), a size, and whether it needs a lawyer (⚖) or a contract or third-party terms (📄). The chat copy of the matrix is a rendering of this file.

**Sizes.** Smaller: under a day · Small: 1 to 3 days · Big: 1 to 2 weeks · Bigger: over 2 weeks, or it depends on outsiders.

## How this file works

- **One file, written by hand, in the same commit as the change it describes**, the way `README.md` and `docs/DECISIONS.md` are kept. A change you make outside a session with me is not in it unless you ask. There is no background process that updates it.
- **A checker** (`npm run backlog:check`, also part of `npm test`) fails when: an ID is used twice or a row lacks its MoSCoW, size, state, marks or risk row; a Built row names no evidence, or evidence (a test, a migration or a file, in backticks) that does not exist; a row is deferred or changes class without citing a decision on record (D-nn); a risk row has no label (SEC, DATA, PAY, ABUSE, OPS, LEGAL, UX, COST) or no containment; or an ID is written anywhere that is not a row.
- **The numbers are generated, never typed.** The counts and the MoSCoW by size grid below come from the tables: `npm run backlog:check -- --write` rewrites them, and the checker fails when they are stale.
- **Against the earlier version** (the file on `origin/main`; where there is none it says so and moves on) the checker also fails when a row disappears, when a Must item leaves Must without a decision on record, and when the register changed without a new change-log entry at least as serious as the change.
- **Update levels**, tagged in the change log: *minor* is wording, evidence or a state moving forward; *major* is a new row, a size change, or a state moving between built and not built; *critical* is anything that touches a Must item (its class, its removal, built turning into not built, its risks).
- **Rows are never deleted.** A dropped item becomes Won't, with the decision cited.
- **What it cannot do:** judge whether the content is true, or whether the named evidence proves enough. The Open check column is where a real-service or real-device check that nobody has run is written down, instead of being implied.

## Change log

Newest first.

<!-- backlog:table changelog -->
| Date | Level | Change |
| --- | --- | --- |
| 2026-10-31 | minor | SEC-16 is fully built: the Windows fix check passed on the owner's own Windows PC. SEC-11 stays open for macOS only (its Windows half passed). |
| 2026-10-29 | minor | SEC-05 is fully built: the owner signed in with a genuine Google account on their own computer and it works; the open check is closed. |
| 2026-10-28 | critical | File created from the approved matrix. SEC-08 and LEG-04 are Must (D-01, D-02); SEC-16 is a built Must; PAY-13 is a Must that is counted and not built (D-07); SEC-06b and LEG-02b are the two splits (D-02). |
| 2026-10-28 | major | SEC-17 to SEC-20 added and built (D-07). The verification pass of the previously unchecked items is recorded in docs/SECURITY.md section 19; what it could not check stays in the Open check column. |
| 2026-10-27 | major | The full admin backend with RBAC added as ADM-01 to ADM-06 (D-08). The first matrix preview, with the risk and containment columns. |

## At a glance

<!-- backlog:summary:start -->
**76 rows: 21 built, 55 not built.** Of the built ones, 5 still have a check open against a real service or device.

| | ✅ Built | ⬜ Not built | Total |
|---|---|---|---|
| Must | 9 | 25 | 34 |
| Should | 8 | 11 | 19 |
| Could | 4 | 10 | 14 |
| Won't this release | 0 | 9 | 9 |
| **All** | **21** | **55** | **76** |

Each ID in the grid carries its state: ✅ built · ⚠️ built, a check is open · ⬜ not built · 🧑 your action, no code · ⏸ deferred by you · 🔭 next version.

| | Smaller | Small | Big | Bigger |
|---|---|---|---|---|
| **MUST** (34) | ⚠️ SEC-07, ⬜ DAT-02, ⬜ PAY-01, ⬜ PAY-05, 🧑 OPS-03, 🧑 BIZ-01, 🧑 BIZ-02 | ✅ SEC-02, ✅ SEC-03, ⚠️ SEC-04, ✅ SEC-05, ✅ SEC-06, ✅ SEC-08, ✅ SEC-16, ⬜ PAY-13, 🧑 LEG-02, 🧑 LEG-04, 🧑 PAY-08a, 🧑 WA-01, 🧑 WA-04 | ⚠️ SEC-01, ⬜ DAT-01, ⬜ PAY-02, ⬜ PAY-07, ⬜ WA-03, ⬜ ADM-01, ⬜ ADM-02, ⬜ OPS-01, ⬜ OPS-02 | 🧑 LEG-01, 🧑 LEG-03, ⬜ PAY-03, ⬜ PAY-04, 🧑 WA-02 |
| **SHOULD** (19) | ✅ SEC-10, ⚠️ SEC-11, ✅ SEC-14, ⬜ PAY-06 | ⚠️ SEC-13, ⬜ WA-06, ⬜ BIZ-03, 🧑 LEG-05, 🧑 OPS-04 | ✅ SEC-06b, ✅ SEC-09, ✅ SEC-12, ✅ SEC-17, ⬜ ADM-03, ⬜ ADM-04, ⬜ LEG-02b, ⬜ PAY-08b, ⬜ PAY-09, ⬜ WA-05 | none |
| **COULD** (14) | ✅ SEC-18 | ✅ SEC-19, ✅ SEC-20 | ⬜ WA-07, ⬜ DSN-01, ⬜ ADM-06, ⬜ PAY-12, ⬜ OPS-05 | ✅ SEC-15, ⬜ BIZ-04, ⬜ BIZ-05, ⬜ BIZ-06, ⬜ ADM-05, ⬜ PAY-11 |
| **WON'T THIS RELEASE** (9) | 🔭 FUT-05 | ⏸ DEF-01, ⏸ DEF-02 | 🔭 FUT-03 | ⏸ DEF-03, ⏸ DEF-04, 🔭 FUT-01, 🔭 FUT-02, 🔭 FUT-04 |
<!-- backlog:summary:end -->

## A. Built

Built means the code is in the repository and its tests pass. **⚠️ rows also have a check against a real service or a real device that nobody has run yet**, named in the Open check column (`docs/SECURITY.md` section 19 says what was checked in the build environment and what was not).

<!-- backlog:table built -->
| ID | Item | MoSCoW | Size | State | Evidence | Open check | ⚖/📄 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-01 | E-mail verification and e-mail sending (findings 1 and 9) | Must | Big | ⚠️ Built, check open | `apps/api/tests/security-auth.test.ts`, `apps/api/tests/mail-providers.test.ts`, `apps/api/tests/mail-templates.test.ts`, `apps/api/prisma/migrations/20261020000000_security_hardening` | No real e-mail provider has been contacted: acceptance and SPF, DKIM and DMARC need your provider key and your sending domain (`npx tsx --env-file=.env scripts/preflight.mts --only mail --domain <yours> --mail-to <you>`) | 📄 e-mail provider |
| SEC-02 | Password reset (finding 2) | Must | Small | ✅ Built | `apps/api/tests/security-auth.test.ts` | — | none |
| SEC-03 | Revocable sessions, sign out everywhere, rotating refresh tokens (finding 3) | Must | Small | ✅ Built | `apps/api/tests/security-auth.test.ts`, `apps/web/tests/proxy-renewal.test.ts`, `scripts/e2e-security.mjs` | — | none |
| SEC-04 | Brute-force defence: rising delays, CAPTCHA after failures, alerts (findings 5 and 10) | Must | Small | ⚠️ Built, check open | `apps/api/tests/security-auth.test.ts`, `apps/api/src/lib/captcha.ts` | Cloudflare Turnstile has never been reached from the build environment (host blocked), and the check fails open when it cannot be reached: run `preflight --only captcha` on your machine, then the widget in a browser on your domain | 📄 CAPTCHA vendor |
| SEC-05 | Lock down `/api/auth/oauth`: verify Google's ID token, link accounts by provider and subject (finding 6) | Must | Small | ✅ Built | `apps/api/tests/security-google.test.ts` | Forged tokens are refused against Google's real keys (`preflight --only google`); a genuine sign-in with the owner's own Google client was done and works (owner's report, 2026-10-29) | none |
| SEC-06 | Export and bulk-action protection: e-mail alert and a daily cap (finding 4; the step-up moved to SEC-06b, D-02) | Must | Small | ✅ Built | `apps/api/tests/security-2fa-stepup.test.ts`, `apps/api/tests/exports.test.ts` | — | none |
| SEC-07 | Trusted client IP behind the proxy (finding 8) | Must | Smaller | ⚠️ Built, check open | `apps/api/tests/security-ops.test.ts`, `apps/web/src/lib/client-ip.ts` | Rehearsed behind a local TLS proxy that sets Cloudflare's headers (the log records the CDN's address, visitor-typed headers are ignored); not behind a real CDN. At deploy set CLIENT_IP_HEADER and let the origin accept traffic only from the CDN: sent straight to the origin, a spoofed header is believed. `npm run share` goes through a real Cloudflare edge | none |
| SEC-08 | Audit log: the owner's own trail, append-only (D-01, was Should) | Must | Small | ✅ Built | `apps/api/tests/security-ops.test.ts`, `apps/api/prisma/migrations/20261020000000_security_hardening` | Limit: staff actions arrive with ADM-01 | none |
| SEC-16 | Upgrade the website framework (Next.js 14.2.35 to 15.5.28, React 19): 25 advisories, one a critical remote-code-execution flaw on Windows servers | Must | Small | ✅ Built | `apps/web/package.json`, `apps/web/tests/proxy-renewal.test.ts`, `scripts/preflight.mts` | Own commit, `git revert` undoes it. The fix is checked under Windows path rules (`preflight --only next`: fails on 15.5.23, passes on 15.5.28) and it was run on the owner's own Windows PC (win32-x64, Node 24.21.0, 2026-10-31): 9 of 9 hostile lookups refused. It is that code run on that Node, not an attack on a running Windows server; the advisory's own page could not be read | none |
| SEC-06b | "Confirm it is you" for large exports and bulk deletes (split from SEC-06, D-02) | Should | Big | ✅ Built | `apps/api/tests/security-2fa-stepup.test.ts`, `apps/api/tests/security-reads.test.ts` | — | none |
| SEC-09 | Two-factor authentication for customers: authenticator app and recovery codes (finding 7) | Should | Big | ✅ Built | `apps/api/tests/security-2fa-stepup.test.ts`, `apps/api/tests/security-crypto.test.ts` | — | none |
| SEC-10 | Generic sign-up response, alias normalisation (findings 9 and 15) | Should | Smaller | ✅ Built | `apps/api/tests/security-auth.test.ts` | — | none |
| SEC-11 | argon2id passwords, no 72-byte truncation (findings 10 and 15) | Should | Smaller | ⚠️ Built, check open | `apps/api/tests/security-crypto.test.ts`, `apps/api/src/lib/password.ts` | Interoperates with the reference C implementation in both directions on Linux (`preflight --only argon2`); on the owner's Windows PC (win32-x64, Node 24.21.0, 2026-10-31) it hashes in 26 ms and verifies, wrong and non-ASCII passwords included. Still open: macOS (the lock carries its binaries, integrity matches), and the comparison with the reference implementation on Windows (Python's argon2-cffi was not installed there) | none |
| SEC-12 | Forced owner filter and a test of every route (finding 12) | Should | Big | ✅ Built | `apps/api/tests/security-isolation.test.ts` | Limit: Postgres row-level security is not built; the guard is the owner filter plus the all-routes test | none |
| SEC-13 | Security headers and a nonce-based CSP (finding 15) | Should | Small | ⚠️ Built, check open | `apps/api/tests/security-ops.test.ts`, `apps/web/src/lib/csp.ts`, `scripts/e2e-security.mjs` | Seen behind a local TLS proxy (HSTS, a fresh nonce per page, `__Host-` cookies, zero CSP violations in the browser run); the Turnstile widget under the CSP and a real CDN are not: `preflight --only headers --url <your site>`, `npm run share` is a real Cloudflare edge | none |
| SEC-14 | Search terms and credentials out of the logs (finding 14) | Should | Smaller | ✅ Built | `apps/api/tests/security-ops.test.ts` | — | none |
| SEC-17 | Dependency majors (zod 4, puppeteer 25, Prisma 7) and an `npm audit` gate before every release (D-07) | Should | Big | ✅ Built | `scripts/audit-gate.mjs`, `scripts/tests/audit-gate.test.mjs`, `docs/audit-allowlist.json`, `apps/api/prisma.config.ts`, `packages/shared/src/zod-setup.test.ts` | Audit: 0 advisories. Needs Node 22.12 or newer; Prisma 7 refuses destructive commands from an AI agent, so the human runs `npm run db:push` | none |
| SEC-15 | App-level encryption of participants' names and phones, with key rotation (built because you listed it) | Could | Bigger | ✅ Built | `apps/api/tests/security-crypto.test.ts`, `scripts/rotate-keys.mts` | — | none |
| SEC-18 | Rate limit keyed by verified session instead of shared address, with a ceiling per address (D-07) | Could | Smaller | ✅ Built | `apps/api/tests/security-ratelimit.test.ts` | — | none |
| SEC-19 | The registrant's password on the confirmation page, closing the last pre-hijacking path (D-07) | Could | Small | ✅ Built | `apps/api/tests/security-auth.test.ts` | — | none |
| SEC-20 | Names and answers: a cap on distinct people read per day, and Google Sheets auto-sync needing re-confirmation (D-07) | Could | Small | ✅ Built | `apps/api/tests/security-reads.test.ts`, `apps/api/tests/exports.test.ts`, `apps/api/prisma/migrations/20261028000000_read_caps_sheets_reconfirm` | — | none |

## B. Not built yet

### B1. Code that can be written now, with nothing from outside

<!-- backlog:table notbuilt -->
| ID | Item | MoSCoW | Size | State | Waiting on | ⚖/📄 |
| --- | --- | --- | --- | --- | --- | --- |
| DAT-01 | Account deletion, data export, retention rules (finding 13; its e-mails and audit log are built; left unbuilt on your instruction, D-05) | Must | Big | ⬜ Not built | Code | ⚖ |
| PAY-02 | Daily reconciliation, wallets against provider balances. Pilot stop-gap: a daily manual check with the SQL query; the automated job before scale (D-02). Not verified: whether providers offer a balance API | Must | Big | ⬜ Not built | Code | none |
| PAY-07 | Resolution screen for "to verify" gifts and payments (delivered inside ADM-02) | Must | Big | ⬜ Not built | Code | none |
| PAY-13 | Payout limits: a cap per account and per phone per day, and a hold on payouts for accounts only a few days old. Counted in the matrix, not built (D-07); a Must for any launch with real payouts | Must | Small | ⬜ Not built | Code | none |
| WA-03 | Per-survey message category, re-categorisation, cost warning | Must | Big | ⬜ Not built | Code | none |
| ADM-01 | Staff foundation: separate admin app, staff accounts, RBAC, mandatory 2FA, audit log (section G; stays Must for a public launch, D-03, D-08) | Must | Big | ⬜ Not built | Code | ⚖ 📄 |
| ADM-02 | Money and customer operations console; needs ADM-01, delivers PAY-07 and the screen of PAY-02 (D-03, D-08) | Must | Big | ⬜ Not built | Code | ⚖ |
| PAY-06 | Unfunded gifts expire after about 30 days | Should | Smaller | ⬜ Not built | Code | none |
| WA-06 | Gift caps per phone and per survey (Must if WA-05 ships) | Should | Small | ⬜ Not built | Code | none |
| BIZ-03 | Measure the 5-person Explore cap; evidence comes from ADM-03 | Should | Small | ⬜ Not built | Code | none |
| ADM-03 | Platform analytics, aggregates only; needs ADM-01 (D-08) | Should | Big | ⬜ Not built | Code | none |
| ADM-04 | Maintenance and health console; needs ADM-01 (D-08) | Should | Big | ⬜ Not built | Code | none |
| WA-07 | Daily summary e-mail and a "50% completed" alert (SEC-01 now exists) | Could | Big | ⬜ Not built | Code | none |
| BIZ-04 | Team members | Could | Bigger | ⬜ Not built | Code | ⚖ |
| BIZ-05 | API access | Could | Bigger | ⬜ Not built | Code | ⚖ |
| BIZ-06 | White-label | Could | Bigger | ⬜ Not built | Code | ⚖ |
| DSN-01 | Dark theme, token export, Storybook | Could | Big | ⬜ Not built | Code | none |
| ADM-05 | Support impersonation ("view as customer"); needs ADM-01 and ADM-02 (D-08) | Could | Bigger | ⬜ Not built | Code | ⚖ |
| ADM-06 | Content and config management; needs ADM-01 (D-08) | Could | Big | ⬜ Not built | Code | ⚖ |

### B2. Waiting on someone else, or on you

Counsel, a payment provider, Meta, the host, Google, or an action or decision of yours (🧑). Starting these is what shortens the road to a launch: they are not code.

<!-- backlog:table notbuilt -->
| ID | Item | MoSCoW | Size | State | Waiting on | ⚖/📄 |
| --- | --- | --- | --- | --- | --- | --- |
| DAT-02 | Encrypted database disk and backups at the host (finding 11; left unbuilt on your instruction, D-05) | Must | Smaller | ⬜ Not built | Host | 📄 host |
| LEG-01 | Privacy Policy and Terms from counsel (the one-page facts sheet is ready: `docs/LEGAL_FACTS_SHEET.md`) | Must | Bigger | 🧑 Your action | Counsel, You | ⚖ |
| LEG-02 | Consent responsibility text (retention moved to LEG-02b, D-02) | Must | Small | 🧑 Your action | Counsel | ⚖ |
| LEG-03 | Is the prepaid wallet regulated as e-money? | Must | Bigger | 🧑 Your action | Counsel | ⚖ 📄 |
| LEG-04 | Data-processing agreement, cross-border clauses (D-02, was Should) | Must | Small | 🧑 Your action | Counsel | ⚖ |
| PAY-01 | Real gift fee from the actual tariffs, card versus Mobile Money | Must | Smaller | ⬜ Not built | Provider | 📄 Campay |
| PAY-03 | Sandbox pass for every collection provider, webhook signing included | Must | Bigger | ⬜ Not built | Provider | 📄 each provider |
| PAY-04 | Verify the Campay gift payout path (airtime and Mobile Money) | Must | Bigger | ⬜ Not built | Provider | 📄 Campay |
| PAY-05 | Confirm the live exchange-rate source and its terms | Must | Smaller | ⬜ Not built | Provider | 📄 rate source |
| PAY-08a | Refund policy for unspent wallet balance (terms, no code) | Must | Small | 🧑 Your action | Counsel | ⚖ |
| WA-01 | Run `meta-check` against a real Meta test app (postponed by you, D-09) | Must | Small | 🧑 Your action | You, Meta | 📄 Meta |
| WA-02 | Meta Tech Provider approval | Must | Bigger | 🧑 Your action | Meta, You | 📄 ⚖ |
| WA-04 | Submit the templates (owner_alert included), number registration (PIN); after WA-02 | Must | Small | 🧑 Your action | Meta, You | 📄 Meta |
| OPS-01 | Production deploy test and a staging site | Must | Big | ⬜ Not built | Host, You | 📄 host |
| OPS-02 | Backups with a restore test, monitoring, error tracking | Must | Big | ⬜ Not built | Host, Code | 📄 host |
| OPS-03 | Published support contact address only, no uptime or incident promise (D-02) | Must | Smaller | 🧑 Your action | You | ⚖ light |
| BIZ-01 | Decide the "soon" claims on the plan cards | Must | Smaller | 🧑 Your action | You | ⚖ claims |
| BIZ-02 | Decide whether Starter includes PDF and Excel | Must | Smaller | 🧑 Your action | You | none |
| LEG-02b | Enforced retention deletion (split from LEG-02, D-02). Partly done: sessions, links, audit rows and unconfirmed accounts are purged. Must if counsel says the law requires it at launch | Should | Big | ⬜ Not built | Code, Counsel | ⚖ |
| LEG-05 | Google OAuth verification, `drive.file` scope (Must if Sheets ships) | Should | Small | 🧑 Your action | Google, You | 📄 Google |
| PAY-08b | Mechanism to refund or withdraw unspent balance | Should | Big | ⬜ Not built | Code, Counsel | ⚖ 📄 |
| PAY-09 | Automatic overage billing | Should | Big | ⬜ Not built | Code, Counsel | ⚖ terms |
| WA-05 | Join a survey by link or QR code; waits for your four answers | Should | Big | ⬜ Not built | You, Code | ⚖ consent |
| OPS-04 | Test on real iPhone and Android phones | Should | Small | 🧑 Your action | You | none |
| PAY-11 | Provider-statement reconciliation, automatic refunds and payouts | Could | Bigger | ⬜ Not built | Code, Provider | ⚖ |
| PAY-12 | Proration on plan changes | Could | Big | ⬜ Not built | Code, Counsel | ⚖ terms |
| OPS-05 | Highly available jobs process | Could | Big | ⬜ Not built | Code, Host | none |

## C. Won't this release (not built)

Deferred by you (⏸) or left for the next version (🔭).

<!-- backlog:table wont -->
| ID | Item | MoSCoW | Size | State | ⚖/📄 |
| --- | --- | --- | --- | --- | --- |
| DEF-01 | Public holidays in reminder timing (D-04) | Won't | Small | ⏸ Deferred by you | none |
| DEF-02 | Founding members, money-back guarantee, time-limited trial (D-04) | Won't | Small | ⏸ Deferred by you | ⚖ guarantee |
| DEF-03 | Selling outside Cameroon (D-04) | Won't | Bigger | ⏸ Deferred by you | ⚖ 📄 |
| DEF-04 | Gift payout rail for Nigeria, Kenya and Ghana (D-04) | Won't | Bigger | ⏸ Deferred by you | 📄 |
| FUT-01 | Builder Bot | Won't | Bigger | 🔭 Next version | none |
| FUT-02 | WhatsApp Flows | Won't | Bigger | 🔭 Next version | none |
| FUT-03 | Per-segment features | Won't | Big | 🔭 Next version | none |
| FUT-04 | Survey branching, loyalty points, charity donations, voucher APIs | Won't | Bigger | 🔭 Next version | none |
| FUT-05 | Recharts funnel chart | Won't | Smaller | 🔭 Next version | none |

## D. Risks and containment

For every row: what it fixes, the risks it brings (with a label), and how they are contained.

### Built

<!-- backlog:table risks -->
| ID | Fixes | New risks | Containment |
| --- | --- | --- | --- |
| SEC-01 | Account pre-hijacking and fake sign-ups; enables alerts and reset | DATA: the e-mail provider sees addresses. SEC: tokens in logs. OPS: undelivered e-mail blocks sign-up. ABUSE: e-mail bombing | Hashed single-use tokens (24 h), no tokens in logs, send limits, SPF, DKIM and DMARC to publish, a processor agreement |
| SEC-02 | Lock-outs and support-led takeover | SEC: reset becomes the takeover route. ABUSE: reset spam | 30-minute hashed token, a generic reply, ends all sessions, a notice to the old address |
| SEC-03 | A stolen token valid for 12 hours | OPS: a bug logs everyone out. UX: more refreshes | Per-session rows, short tokens with rotating refresh, the proxy renewal tests |
| SEC-04 | Password guessing | ABUSE: a victim's login can be slowed. DATA: the CAPTCHA vendor sees addresses. UX: friction | Rising delays, CAPTCHA only after failures, a privacy-friendly vendor; fails open if the vendor is unreachable |
| SEC-05 | Login as any e-mail address if the shared secret leaks | SEC: token-check bugs. UX: users asked to confirm | A vetted library, link by provider and subject, a confirmation e-mail, tests |
| SEC-06 | One login exposing all contacts | UX: friction. OPS: depends on e-mail | An alert and a daily cap, no data in e-mails |
| SEC-06b | A stolen login exporting or deleting in bulk | UX: friction | Step-up only for large actions, a 15-minute window |
| SEC-07 | Spoofed addresses defeat rate limits and hide in the log | OPS: misconfiguration. SEC: a header is believed when the origin can be reached directly | One setting (CLIENT_IP_HEADER or TRUSTED_PROXY_HOPS), tests, the preflight headers check, the origin reachable only through the CDN |
| SEC-08 | No trace of who did what | DATA: the log holds personal data | Minimal fields, an address prefix only, an append-only trigger, retention |
| SEC-09 | A stolen password is enough | SEC: recovery codes are the weak point. UX: a lost phone | Hashed codes, an encrypted secret, a recovery path |
| SEC-10 | Probing and alias farming | UX: a confusing message and rare wrong merges | Clear wording, known patterns only |
| SEC-11 | Weak hashing and 72-byte truncation | OPS: migration errors, and cost on a small host | Re-hash on sign-in, bcrypt still verifies, the cost is a setting, measured by the preflight |
| SEC-12 | One forgotten filter leaks everything | OPS: broken queries | A forced owner filter, a test over every route, a route inventory guard |
| SEC-13 | Weak browser protections | UX: the CSP breaks a script | A report-only mode, zero violations in the browser run, a nonce per page |
| SEC-14 | Phone numbers and tokens in logs | none notable | Strip queries and credentials |
| SEC-15 | Plain-text names and phones in the database | OPS: key management. UX: phone search breaks | A keyed hash index, a key ring, a rotation script |
| SEC-16 | Twenty-five advisories in the old framework, one an unauthenticated remote-code-execution flaw on Windows hosts | OPS: a major upgrade breaks a page | The full browser regression, its own commit (git revert), the preflight next check |
| SEC-17 | Seventeen advisories in production dependencies | OPS: major versions change behaviour (Prisma 7 adapter, zod 4 defaults, Node 22.12; zod 4 probing for eval under the CSP, found by the browser run and switched off in browsers) | Tests and browser runs after each step, an audit gate with dated exceptions |
| SEC-18 | Busy pages throttled because many mobile subscribers share one address | ABUSE: one source multiplying sessions | A ceiling per address on top of the per-session limit, keys from verified tokens only |
| SEC-19 | The last account pre-hijacking path | UX: one more step on the confirmation page | Five wrong passwords burn the link, a switch (CONFIRM_REQUIRES_PASSWORD) |
| SEC-20 | Only numbers were protected from bulk reading; names and answers were not | UX: friction for large legitimate lists. ABUSE: a slow scraper under the soft cap | A count of distinct people per 24 hours, step-up past the soft number, a hard stop, one e-mail, an audit row |

### Not built yet

<!-- backlog:table risks -->
| ID | Fixes | New risks | Containment |
| --- | --- | --- | --- |
| DAT-01 | No erasure or export | DATA: irreversible deletion; the export file is a leak. PAY: the ledger must stay | A 30-day grace period, re-authentication, keep minimal financial records, an expiring signed link |
| DAT-02 | Plain text at rest and in backups | OPS: a lost key. COST: managed encryption | Managed encryption, restore tests |
| LEG-01 | No counsel-approved text | LEGAL: promises beyond the product | The lawyer works from the facts sheet, updated when the product changes |
| LEG-02 | Unclear consent responsibility | DATA: consent proof is more personal data | Timestamp and owner only |
| LEG-02b | Data kept longer than promised | DATA: irreversible deletion | A grace period, counsel sets the periods, a dry-run report first |
| LEG-03 | Holding customer money without a licence | PAY: may force a licensed-partner redesign | Decide before any real top-up |
| LEG-04 | No data-handling contract with customers | LEGAL: breach-notice duties | A short template reviewed by counsel |
| LEG-05 | Google review delay | UX: `drive.file` changes how Sheets sync works | Switch scope, confirm with Google |
| PAY-01 | A loss on every gift | UX/COST: a higher price may deter | The fee shown in the cost panel, separate card and Mobile Money fees |
| PAY-02 | A silent cash shortfall | SEC: balance-read credentials. OPS: false alarms | Read-only keys, thresholds, de-duplicated alerts; the stop-gap is a daily SQL check |
| PAY-03 | Collection adapters never run against a real provider | PAY: the sandbox differs from production. SEC: test keys leaking | A secret manager, tiny live amounts first, a per-provider kill switch |
| PAY-04 | Owners' prepaid money flows through unverified payout calls | PAY: an irreversible payout to a wrong number. SEC: payout keys can spend money | Tiny live payouts to your own numbers, a spending cap, a separate payout key, a daily ceiling, a kill switch |
| PAY-05 | An unverified rate source | LEGAL: attribution terms | Check the terms, one real fetch |
| PAY-06 | Stale gifts to strangers | PAY: an owner loses an obligation unnoticed | Warn before expiry, let the owner release first |
| PAY-07 | Unresolved "to verify" money | SEC: a staff screen is a new privileged surface. PAY: manual errors | Delivered inside ADM-02 with its containment; the stop-gap is scripts/payments-review.mts |
| PAY-08a | No answer to "what happens to my leftover money" | LEGAL: promises refunds the team can only do by hand. PAY: a cash-outflow obligation | Wording that matches what support can do, reviewed by counsel, consistent with LEG-03 |
| PAY-08b | Owners cannot recover unspent money alone | PAY: a stolen-card top-up, then a withdrawal. LEGAL: anti-money-laundering | A cooling period, refund to the original method, KYC above a threshold |
| PAY-09 | Revenue not collected | PAY: surprise charges | Opt-in, a warning at 80%, invoice e-mails |
| PAY-11 | Manual refunds, no statement matching | PAY: automatic refunds can loop | Limits and an approval step |
| PAY-12 | An upgrade starts a new period | PAY: calculation errors | A cap, tests, counsel on the terms |
| PAY-13 | A wallet top-up by card followed by gifts to Mobile Money numbers is a cash-out route for stolen cards, and the chargeback arrives after the money has gone | UX: an honest owner meets a cap. PAY: caps set too high do nothing | A cap per account and per phone per day, a hold on payouts for young accounts, sized against the providers' dispute terms (docs/PAYMENTS.md, section on chargebacks) |
| WA-01, WA-02, WA-04 | Unverified Meta, no approval, unsubmitted templates | COST: Meta billing. OPS: rejections. SEC: tokens in tests | A test app first, an alert on rejection, tokens only in the environment |
| WA-03 | Wrong cost and category | COST: marketing messages cost more. LEGAL: promotions sent as "utility" | Default to marketing when unsure, wording rules, a cost warning |
| WA-05 | Owners cannot reach people outside their contacts | ABUSE: gift farming and spam. DATA: public numbers. SEC: guessable links. COST: quota use | Unguessable codes, expiry, caps (WA-06), a country limit, a consent line and STOP, joiners count toward the Explore cap |
| WA-06 | Gift farming through a public link | UX: honest users capped | One gift per number per survey, a per-survey ceiling, a gifts switch |
| WA-07 | No owner alerts by e-mail or WhatsApp | COST: billed to SurveyFlow. ABUSE: spam | Reuse the bot's caps and mute |
| BIZ-01, BIZ-02, OPS-03 | Unpublished support, false "soon" claims, open pricing | LEGAL/UX: promising what does not exist | Publish only what you can honour |
| BIZ-03, OPS-04 | A guessed cap, untested devices | none notable | Use the funnel events, test real devices |
| BIZ-04 | Single-user accounts | SEC: privilege escalation. DATA: more people see contacts | Roles, a per-member audit, 2FA |
| BIZ-05 | No integrations | SEC: leaked keys and contact scraping | Scoped hashed keys, rate limits, an IP allowlist |
| BIZ-06 | No branding | SEC: custom-domain takeover. LEGAL: Meta display-name rules | DNS verification, manual review |
| DSN-01, OPS-05 | No dark theme, a single-leader jobs process | PAY: several leaders could double-process | Keep the claim-once locks |
| OPS-01, OPS-02 | An untested deploy, no backup proof | DATA: backups hold personal data. SEC: secrets in logs | Encrypted backups with retention, boot checks |
| ADM-01 | Operators would otherwise work in SQL and scripts, with no roles or trail | SEC: one stolen admin login exposes everything. SEC: a larger attack surface, with IDOR risk | Mandatory 2FA, a separate origin and session, VPN or gateway, short sessions, login alerts, the same security tests as the customer app, an access check on every record |
| ADM-02 | Owners' money problems and deletion requests have no tool | DATA: insider access to participants' data is the biggest new leak. ABUSE: refund fraud, snooping. PAY: manual errors | Masking and aggregates by default, a logged reveal with a reason, no bulk export from admin, two-person approval for money, amounts from the ledger, an immutable audit log, a quarterly access review |
| ADM-03 | Decisions made without data (conversion, cap, margins) | DATA: aggregates can still reveal individuals in small groups | A minimum group size in every chart, no row-level export |
| ADM-04 | Slow, risky maintenance and no way to stop a failing provider | OPS: a wrong flag or kill switch takes the service down | A confirmation step, recorded changes, a safe default per flag, a 2FA re-check for kill switches |
| ADM-05 | Support cannot see what a customer sees | ABUSE: the most abusable feature (act as the customer). DATA: sees contacts. LEGAL: needs a legal basis | Customer consent, time-boxed, a visible banner, read-only by default, fully logged, no money actions while impersonating |
| ADM-06 | Prices and legal text need a deploy to change | LEGAL: wrong text goes live. PAY: a wrong price | Draft, review and publish steps with versions, a second approver |

### Won't this release

<!-- backlog:table risks -->
| ID | Fixes | New risks | Containment |
| --- | --- | --- | --- |
| DEF-01 | Reminders can go out on public holidays | UX: wrong calendars per country | A per-country calendar with an owner override |
| DEF-02 | None today | PAY: discount and refund abuse | Revisit with conversion data |
| DEF-03 | A single market | OPS: DST and cents errors. LEGAL: each country's laws | Minor-unit amounts first, counsel per country |
| DEF-04 | Foreign gifts fail and are refunded | PAY: FX risk | A payout provider per country |
| FUT-01 | Feature gap | SEC: a phone-linking spoof. COST: Meta fees | Reuse the Analytics Bot linking code |
| FUT-02, FUT-03, FUT-04, FUT-05 | Feature gaps | none notable | Revisit in the next version |

## E. Decisions on record

Your decisions that rows cite. A row that is deferred, or that changed its MoSCoW class, must cite one of these.

<!-- backlog:table decisions -->
| Ref | Date | Decision | Source |
| --- | --- | --- | --- |
| D-01 | 2026-10-28 | The MoSCoW placement is approved as previewed, with SEC-08 (audit log) moved from Should to Must. | "SEC-08 become MUST item … I approve the MoSCoW placement." |
| D-02 | 2026-10-28 | The pushbacks on SEC-06, LEG-02, OPS-03, PAY-02 and LEG-04 are accepted and the splits applied: SEC-06 gives SEC-06b, LEG-02 gives LEG-02b, OPS-03 shrinks to a support contact address, PAY-02 gets a pilot stop-gap, LEG-04 moves from Should to Must. | "I approve your proposal on the pushback on the following items (SEC-06, LEG-02, OPS-03, PAY-02 and LEG-04.) so apply the split to them" |
| D-03 | 2026-10-28 | Launch is defined as "public with real money", so ADM-01 and ADM-02 stay Must. The pushback (an invited pilot first) was asked for and delivered; the answer to it is open, see section F. | "I expect pushback on Launch definition: public with real money." |
| D-04 | 2026-10-28 | The deferred items stay deferred: DEF-01 to DEF-04. | "I confirm DEFERRED BY YOU items." |
| D-05 | 2026-10-28 | Build every security finding and every SEC item except findings 11 and 13, which are DAT-02 and DAT-01 and stay unbuilt. | "From the findings DON'T BUILD or LEAVE finding 11 and finding 13 because are DAT-01 and DAT-02 in the matrix." |
| D-06 | 2026-10-28 | The living-document mechanism with its checker is approved and was built on this date. | "I Approve the living-document mechanism, including the checker." and "build finally backlog and its checker as i have approved the mechanism" |
| D-07 | 2026-10-28 | Of the five proposed rows, SEC-17 to SEC-20 are applied and built; PAY-13 is counted in the final matrix but not applied or built. | "apply and build all the SEC do not build/apply the PAY-13, but count all the proposed rows in the final matrix" |
| D-08 | 2026-10-27 | The full admin backend with RBAC is added as ADM-01 to ADM-06. | "add also the full admin backend feature with RBAC mechanism" |
| D-09 | 2026-10-17 | The check against a real Meta app (WA-01) is postponed by you; the reminder you asked for is still owed. | "I'll verify real Meta as per META_CHECK.md later (you'll remind me later this weekend …)" |

## F. Open questions for you

1. **Launch definition.** "Public with real money" is on record (D-03). My advice has not changed: an invited pilot with real money first (sign-up by invitation, 5 to 20 owners, caps on top-ups and payouts as in PAY-13, money operations by runbook), with ADM-01, ADM-02, PAY-07 and DAT-01 dropped to Should for that stage only. If you accept it, the classes change and the decision is recorded here.
2. **PAY-13** is counted and not built (D-07). It is a Must for any launch with real payouts: say when.
3. **The Next.js upgrade** (SEC-16) stays unless you say to revert it (`git revert` of its commit).
4. **The smaller open questions** of `docs/SECURITY.md` section 17: whether an unconfirmed account may browse (it can), names and answers behind a stolen login (capped by SEC-20, not masked), CAPTCHA off in production, a rate limit per address or per session (per session now, SEC-18).
5. **WA-01**: you asked me to remind you about the real-Meta check (D-09). It is still the most valuable open check: nothing said about WhatsApp is worth much until the product has run once against the real API.

## G. The admin backend (ADM-01 to ADM-06)

For SurveyFlow staff: money operations, customer support, analytics, maintenance. Designed, not built (D-08).

| ID | What it contains |
|---|---|
| ADM-01 Foundation | A separate admin app on its own origin, with its own session cookie and token audience. Staff accounts are created only by a super admin, no self-registration, and offboarding revokes everything. RBAC with resource:action permissions, deny by default. Mandatory 2FA, a hardware key preferred. A built-in audit log. Network restriction (VPN or an access gateway). An alert on every admin login. Short sessions. |
| ADM-02 Money and customer operations | Customer lookup showing plan, wallet and payment status without participants' personal data. The "to verify" queue for gifts and payments (PAY-07). The reconciliation view of wallet totals against provider balances (the screen of PAY-02). The queue of deletion and export requests (DAT-01). Suspend and unsuspend. Refunds with two-person approval and amounts taken from the ledger. |
| ADM-03 Platform analytics | The conversion funnel, the evidence for the Explore cap (BIZ-03), revenue and plan mix, message volume, provider fees and Meta spend against revenue, gift cost against fee. Aggregates only. |
| ADM-04 Maintenance and health | Job and queue status, provider health and circuit-breaker state, per-provider kill switches, template approval status, exchange-rate freshness, feature flags. |
| ADM-05 Impersonation | Staff view the app as a customer, with the customer's consent, a time limit and a visible banner. |
| ADM-06 Content and config | Plan prices, announcements, legal-text versions, template wording. |

| Role | Can | Cannot |
|---|---|---|
| Super admin (2 people, break-glass) | Create staff, assign roles, everything | Approve their own refund |
| Finance and payments operations | Money queues, reconciliation, refunds (a second approver is needed) | See participants' contacts |
| Support | Customer lookup, plan and status, request queues | See participants' phone numbers or answers without a logged reason |
| Trust and compliance | Deletion and export requests, abuse cases, suspensions | Move money |
| Analyst | Aggregated analytics | Any individual customer's or participant's data |
| Maintainer | Health, queues, flags, kill switches | Customer data |
| Auditor | The audit log, read-only | Anything else |

**Mechanics.** The requester of a sensitive action cannot approve it. Personal data is masked by default, and revealing it needs a reason and is logged. Elevated access is time-boxed. Every record access is checked, not just every route.

**Dependencies.** The admin backend delivers PAY-07, the screen of PAY-02, the handling side of DAT-01 and the data for BIZ-03. It needs the audit log (SEC-08, included in ADM-01), staff 2FA (included in ADM-01), revocable sessions (SEC-03) and, helpfully, a tested owner filter (SEC-12).
