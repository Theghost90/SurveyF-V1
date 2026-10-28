# SurveyFlow — WhatsApp-native surveys for Cameroon

Build a survey on the web, send it on WhatsApp, collect answers inside the chat, watch live analytics, export to
PDF / Excel / Google Sheets, reward participants with airtime, Mobile Money, codes or a prize draw, and ask the **Analytics Bot** for your numbers from your own phone. Free to explore (1 live survey, 5 people reached),
then billed in FCFA (MTN MoMo, Orange Money, card) or, in Nigeria, Kenya and Ghana, in the local currency by card, through a multi-PSP orchestration layer.

> **Read [`docs/DECISIONS.md`](docs/DECISIONS.md) first.** It lists where this build departs from the spec/design (and why),
> the open business decisions, and exactly which integrations are verified vs. not. Sign-in and data protection (confirmed e-mail, sessions, authenticator app, masked numbers,
> encryption of names and numbers, what is *not* covered, how to rotate keys) are in [`docs/SECURITY.md`](docs/SECURITY.md). What is built and what is not, item by item, is in [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Stack

| | |
|---|---|
| Web | Next.js 15 (App Router) with React 19, TypeScript, Tailwind, shadcn-style components (Radix), NextAuth, Recharts, dnd-kit — **port 4222** |
| API | Node.js **22.12 or newer** + Fastify, TypeScript, zod 4 — **port 4223** |
| Data | PostgreSQL (Prisma 7 with the node-postgres adapter), Redis (ioredis) |
| WhatsApp | Meta Cloud API client + a local **mock gateway/simulator** |
| Exports | ExcelJS · Puppeteer + Chart.js · Google Sheets API v4 (REST) |
| Payments | Notch Pay · CinetPay · Campay · CamerPay · PayUnit · Flutterwave behind one adapter interface, picked silently per payment (cheapest first, with failover) + a demo "mock" PSP |
| Design | Tokens and layouts from the "SurveyFlow Hero & Pricing" artifact — **Hero A** and **Pricing A** |

**Letting someone test it over the internet:** `npm run share`, see `docs/SHARE_DEMO.md` (and give the tester `docs/TESTER_GUIDE.md`).

## Run it locally (demo mode, no external accounts needed)

Needs **Node.js 22.12 or newer** (puppeteer 25 and the Prisma 7 tools require it; `node -v`), npm, and Postgres 16 and Redis 7 (`docker compose up -d` starts both).

```bash
cp .env.example .env            # then set the secrets (see below); defaults are fine for a local preview
docker compose up -d            # Postgres + Redis   (or use your own and edit DATABASE_URL / REDIS_URL)
npm install
npm run db:push                 # create the schema  (production uses `prisma migrate deploy`, see below). Run it yourself: the Prisma 7 command line refuses destructive commands from an AI agent
npm run db:seed                 # demo account: demo@surveyflow.test / demo-password-123 (Growth plan)
npm run dev                     # API :4223 + web :4222   →  http://localhost:4222
```

In demo mode (`WHATSAPP_MODE=mock`, `PSP_MOCK=true`, `GIFT_PROVIDER=mock`) nothing leaves your machine:

* **Settings → WhatsApp → "Use a simulated number"** connects a fake number; the **Simulator** page (`/simulator`) plays the
  *participant's phone* against the real, signature-checked webhook code path — tap buttons, answer, skip 25 h to trigger
  abandonment.
* **Sign-up asks for a confirmed e-mail address.** In demo mode nothing is sent: the "check your e-mail" page shows the message with a button (the mock mailbox: **any visitor of a shared demo can read any test mailbox, so never use a real address**).
  The seeded demo account is already confirmed.
* Subscribing opens a **demo checkout** (`/billing/mock-checkout`) that exercises the real verification + activation path.
* Gifts are "delivered" by a mock provider. **The survey owner pays for gifts** from a prepaid wallet (Billing → Gift wallet, topped up
  through the same mock checkout). The seeded demo account has a funded wallet; a fresh account starts at 0, so its participants get a plain
  thank-you until it is topped up — see `docs/DECISIONS.md` §3.1.

For a production-like preview: `npm run build && npm start` (the API reads the root `.env`; set `DATABASE_URL`/`REDIS_URL` there or in the environment).

## Going live (checklist)

1. Postgres + Redis; `npx prisma migrate deploy --config apps/api/prisma.config.ts` (Prisma 7 reads its settings from that file; `apps/api/prisma/migrations`, eleven: `init`, `gift_wallet`, `reminders_geo_segment`, `multicurrency_wallet`, `payments_notices`, `payments_reconcile`, `explore_activate`, `analytics_bot`, `analytics_alerts`, `security_hardening`, `read_caps_sheets_reconfirm`; applied from scratch and diffed against the schema — no drift, checked 2026-10-28 on Prisma 7 with `prisma migrate diff`). Node 22.12 or newer on the host.
2. Set **production** env: `NODE_ENV=production`, `JWT_SECRET`, `ENCRYPTION_KEYS` (`k1:` + `openssl rand -base64 32`), `BLIND_INDEX_KEY` (`openssl rand -base64 32`), `NEXTAUTH_SECRET`, `NEXTAUTH_URL` and `PUBLIC_WEB_URL` (both https),
   `EMAIL_PROVIDER` (`smtp`, `resend` or `brevo`) with its key and a verified `EMAIL_FROM`, `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY` (or `CAPTCHA_DISABLED=true`), and on the website `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) or `TRUSTED_PROXY_HOPS`,
   `WHATSAPP_MODE=live`, `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, PSP keys, `GIFT_PROVIDER=campay`. **The API refuses to start**
   in production with mock modes (WhatsApp, payments, gifts, **e-mail**), a missing app secret, missing encryption keys, or weak secrets. **Back up `ENCRYPTION_KEYS` and `BLIND_INDEX_KEY` apart from the database: without them participants' names and numbers cannot be read.**
   The website must be reachable only through your CDN, and the security part of the checklist is `docs/SECURITY.md` §15.3. Set `GIFT_FEE_PERCENT` from the real provider tariffs (default 5 is a
   placeholder) and settle the legal/treasury questions in `docs/DECISIONS.md` §3.1 **before accepting real wallet top-ups**.
   Also: set `INTERNAL_API_SECRET` (same value for the API and the website; the API refuses to start in production without it) so that only the website's server can call the API — the exceptions are Meta's
   webhook, the PSP webhooks and receipt links; `PUBLIC_API_URL` must be the API's public **https** address (checked at startup); the site must sit behind a platform that sets a country header (Vercel, Cloudflare,
   CloudFront) or visitors are treated as Cameroon / FCFA; non-FCFA prices need the live rate source reachable (`FX_API_URL`, see `.env.example`); `PSP_FEES` / `CAMERPAY_PLAN` refine the provider ranking
   (documented fees are built in: `docs/DECISIONS.md` §3.3).
3. Meta: point the app's webhook at `https://<api>/api/webhook/whatsapp`, subscribe to `messages` and `message_template_status_update`, configure Embedded Signup. **Run `scripts/meta-check.mts` first** (it runs the production gateway against your Meta test app and says what passes, what Meta rejects and what no script can cover): `docs/META_CHECK.md`.
4. Each PSP: sandbox pass first (see the table in `docs/DECISIONS.md` §4) — Campay and PayUnit especially. Register `https://<api>/api/payments/webhook/<psp>` in each provider's dashboard and set its webhook secret (the API warns at boot when one is missing and **refuses to start in production with no provider at all**). Keep the jobs process running (`RUN_JOBS=true`): the payment reconciliation job is what finds a payment whose webhook never came. Payments that need a person: `scripts/payments-review.mts` (`docs/PAYMENTS.md`).
5. Replace the draft `/privacy` and `/terms` with counsel-approved text; set `NEXT_PUBLIC_SALES_WHATSAPP` for the agencies CTA.
6. Deploy templates (untested here — no Docker daemon): `apps/api/Dockerfile`, `deploy/fly.api.toml`, `deploy/railway.json`, `apps/web/vercel.json`.
7. On the deployed site run **`npx tsx --env-file=.env scripts/preflight.mts --url https://<your site> --domain <sender domain> --mail-to <you>`**: it checks, with the production code, what the tests can only fake (e-mail and its DNS records, Turnstile, haveibeenpwned, https, HSTS, the cookies, the CSP, argon2 on that host, the Windows fix of Next.js): `docs/SECURITY.md` §19. And **`npm run release:check`** before every release (typecheck, lint, every test and the `npm audit` gate).

## Repository layout

```
apps/api            Fastify API, Prisma schema + migrations, workers (send queue, abandonment sweeper, gifts, billing)
  src/services/survey/engine.ts      pure state machine (unit-tested)
  src/services/survey/handler.ts     webhook → engine → DB/Redis → reply
  src/services/whatsapp/             gateway (Cloud API + mock), send queue, templates
  src/services/payments/             router, adapters, settlement (idempotent, amount-verified)
  src/services/{analytics,exports,gifts,subscription}/
  src/services/analytics-bot.ts      Analytics Bot: owner linking, commands, shared formatters (analytics-alerts.ts: milestone and slowdown alerts)
  src/services/{reminders,fx,wallet,receipts,funnel}.ts
apps/web            Next.js app (marketing, auth, dashboard, builder, analytics, billing, simulator)
packages/shared     plans & prices (single source of truth), phone normalisation, WhatsApp message builders
apps/web/tests      tests of the website's API proxy (token renewal, cookie rules, refusals)
scripts/            share-demo.mjs (npm run share), e2e-*.mjs browser tests (ui, bot, wallet, payments, currency, security, responsive, landscape), rotate-keys.mts (encryption key rotation), preflight.mts (checks against the real services), audit-gate.mjs (npm run audit:gate),
                    backlog-check.mjs (npm run backlog:check), tests/ (their unit tests), ui-tour.mjs and shoot.mjs (screenshots)
surveyflow_design.md   design specification: tokens, layout and navigation, components, responsive rules
docs/DECISIONS.md   spec/design deviations, open questions, verification status
docs/BACKLOG.md     the living backlog: every item, built or not, with MoSCoW class, size, risks, evidence and the decisions behind it (checked by `npm run backlog:check`)
docs/SECURITY.md    sign-in and data protection: what is built, operations (keys, rotation, incidents), what is not covered, the verification log (§19)
docs/audit-allowlist.json   dated exceptions to the `npm audit` gate (empty)
docs/LEGAL_FACTS_SHEET.md (+ .docx)   one page for the lawyer: what the software does with data today
docs/SHARE_DEMO.md, docs/TESTER_GUIDE.md   sharing a test instance over the internet; what to hand the tester
docs/SurveyFlow_V1_Reverse_Engineered_Blueprint.docx   the build blueprint with the full testing plan
docs/PAYMENTS.md    payment flow vs the PSP diagram, risk register, operations guide, what is not covered
docs/META_CHECK.md  running the WhatsApp integration against a real Meta test app
```

## Tests

```bash
npm test                          # shared (71) + API (463) + website (14) tests, then the script tests (37) and the backlog check. Needs the local Postgres/Redis; the API tests use the `surveyflow_test` database
npm run typecheck                 # the three workspaces
npm run audit:gate                # npm audit --omit=dev: fails on a high or critical advisory that is not written in docs/audit-allowlist.json with a reason and an end date
npm run release:check             # typecheck + the website's lint + npm test + the audit gate: before every release
npx tsx --env-file=.env scripts/preflight.mts   # what only a real service or host can settle: e-mail, Turnstile, haveibeenpwned, Google's keys, argon2, https headers, the Next.js Windows fix (docs/SECURITY.md §19; --url, --domain, --mail-to)
node scripts/e2e-ui.mjs /tmp/e2e # real-browser end-to-end run against the running app on :4222 (reseed first: `npm run db:seed`)
node scripts/e2e-wallet.mjs /tmp/e2e-wallet # wallet + gift receipt run
node scripts/e2e-payments.mjs /tmp/e2e-payments # what a customer sees: still waiting, in progress, review, renewal banner
node scripts/fx-stub.mjs & # fixed exchange rates for offline demos (API: FX_API_URL=http://127.0.0.1:4299/v6/latest/XAF)
node scripts/e2e-bot.mjs /tmp/e2e-bot # Analytics Bot: link a phone, owner simulator, RESULTS, alerts switch, live preview
node scripts/e2e-responsive.mjs /tmp/e2e-resp # every screen from 320 to 1920 px, both menus: no horizontal overflow
node scripts/e2e-landscape.mjs /tmp/e2e-land # menu bars at every width from 280 px and screens on 30 device orientations (portrait + landscape), English and French
node scripts/e2e-currency.mjs /tmp/e2e-currency # a Kenyan owner: plan, wallet and gifts in shillings
SF_SHORT_TOKENS=1 node scripts/e2e-security.mjs /tmp/e2e-sec # sign-up to sign-out, authenticator app, sessions, "confirm it is you"; start the API with ACCESS_TOKEN_TTL_SECONDS=30 so renewal is tested throughout
```

## The backlog

`docs/BACKLOG.md` is the living list of every item, built or not, with its MoSCoW class, size, risks and the decisions behind it. **Update it in the same commit as the change it describes**: a new item, a state that moves, a decision of the owner. `npm run backlog:check` (part of `npm test`) fails
when it contradicts itself or the repository (a built row whose evidence is missing, a Must item that left Must without a recorded decision, counts that are not what the tables add up to), and `npm run backlog:check -- --write` regenerates its counts. It cannot judge whether what the file says is true.

## API (all under `/api`)

`POST auth/{register,verify-email[/resend],login,refresh,signout,logout}` · `POST auth/password/{forgot,reset,change}` · `POST auth/google[/link/confirm]` (Google sign-in; verified ID token) · `POST auth/2fa/{setup,enable,disable,recovery-codes}` ·
`GET|POST auth/step-up[/email-code]` · `GET auth/{config,sessions,security,activity}` · `DELETE auth/sessions/:id` · `POST auth/sessions/revoke-all` · `POST contacts/:id/reveal` · `GET|PATCH auth/me` · `GET|POST surveys` · `GET|PUT|DELETE surveys/:id` ·
`POST surveys/:id/{publish,pause,resume,close,duplicate,send,audience,remind,draw}` · `GET surveys/:id/{analytics,responses,recipients,gifts,sync}` ·
`POST surveys/:id/gifts/{retry,release}` · `GET wallet` · `POST wallet/topup` ·
`GET surveys/:id/export/{pdf,excel}` · `POST|DELETE surveys/:id/sync/google-sheets` · `GET contacts` · `POST contacts[/import|/bulk-delete|/bulk-tag]` ·
`GET|POST|PATCH|DELETE analytics-bot…` (link a phone, list, mute) · `GET surveys/:id/not-started[.csv]` · `GET|POST webhook/whatsapp` · `GET receipts/:token` (public PDF, delivered gifts only) · `GET pricing` (prices in the visitor's currency) · `POST payments/initiate` · `GET payments[/:id]` · `GET|POST payments/webhook/:psp` ·
`GET subscription` · `PUT subscription/upgrade` · `POST subscription/{cancel,reactivate}` · `GET|POST whatsapp/{accounts…,embedded-signup,config}` · `GET integrations/google…`
