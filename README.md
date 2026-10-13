# SurveyFlow — WhatsApp-native surveys for Cameroon

Build a survey on the web, send it on WhatsApp, collect answers inside the chat, watch live analytics, export to
PDF / Excel / Google Sheets, reward participants with airtime, Mobile Money, codes or a prize draw. Billed in FCFA
(MTN MoMo, Orange Money, card) through a multi-PSP orchestration layer.

> **Read [`docs/DECISIONS.md`](docs/DECISIONS.md) first.** It lists where this build departs from the spec/design (and why),
> the open business decisions, and exactly which integrations are verified vs. not.

## Stack

| | |
|---|---|
| Web | Next.js 14 (App Router), TypeScript, Tailwind, shadcn-style components (Radix), NextAuth, Recharts, dnd-kit — **port 4222** |
| API | Node.js + Fastify, TypeScript — **port 4223** |
| Data | PostgreSQL (Prisma), Redis (ioredis) |
| WhatsApp | Meta Cloud API client + a local **mock gateway/simulator** |
| Exports | ExcelJS · Puppeteer + Chart.js · Google Sheets API v4 (REST) |
| Payments | Notch Pay · CinetPay · Campay · PayUnit · Flutterwave behind one adapter interface, with failover + a demo "mock" PSP |
| Design | Tokens and layouts from the "SurveyFlow Hero & Pricing" artifact — **Hero A** and **Pricing A** |

## Run it locally (demo mode, no external accounts needed)

```bash
cp .env.example .env            # then set the secrets (see below); defaults are fine for a local preview
docker compose up -d            # Postgres + Redis   (or use your own and edit DATABASE_URL / REDIS_URL)
npm install
npm run db:push                 # create the schema  (production uses `prisma migrate deploy`, see below)
npm run db:seed                 # demo account: demo@surveyflow.test / demo-password-123 (Growth plan)
npm run dev                     # API :4223 + web :4222   →  http://localhost:4222
```

In demo mode (`WHATSAPP_MODE=mock`, `PSP_MOCK=true`, `GIFT_PROVIDER=mock`) nothing leaves your machine:

* **Settings → WhatsApp → "Use a simulated number"** connects a fake number; the **Simulator** page (`/simulator`) plays the
  *participant's phone* against the real, signature-checked webhook code path — tap buttons, answer, skip 25 h to trigger
  abandonment.
* Subscribing opens a **demo checkout** (`/billing/mock-checkout`) that exercises the real verification + activation path.
* Gifts are "delivered" by a mock provider.

For a production-like preview: `npm run build && npm start`.

## Going live (checklist)

1. Postgres + Redis; `npx prisma migrate deploy` (the initial migration is in `apps/api/prisma/migrations`, verified against the schema).
2. Set **production** env: `NODE_ENV=production`, `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`), `NEXTAUTH_SECRET`,
   `WHATSAPP_MODE=live`, `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, PSP keys, `GIFT_PROVIDER=campay`. **The API refuses to start**
   in production with mock modes, a missing app secret, or weak secrets.
3. Meta: point the app's webhook at `https://<api>/api/webhook/whatsapp`, subscribe to `messages`, configure Embedded Signup.
4. Each PSP: sandbox pass first (see the table in `docs/DECISIONS.md` §4) — Campay and PayUnit especially.
5. Replace the draft `/privacy` and `/terms` with counsel-approved text; set `NEXT_PUBLIC_SALES_WHATSAPP` for the agencies CTA.
6. Deploy templates (untested here — no Docker daemon): `apps/api/Dockerfile`, `deploy/fly.api.toml`, `deploy/railway.json`, `apps/web/vercel.json`.

## Repository layout

```
apps/api            Fastify API, Prisma schema + migrations, workers (send queue, abandonment sweeper, gifts, billing)
  src/services/survey/engine.ts      pure state machine (unit-tested)
  src/services/survey/handler.ts     webhook → engine → DB/Redis → reply
  src/services/whatsapp/             gateway (Cloud API + mock), send queue, templates
  src/services/payments/             router, adapters, settlement (idempotent, amount-verified)
  src/services/{analytics,exports,gifts,subscription}/
apps/web            Next.js app (marketing, auth, dashboard, builder, analytics, billing, simulator)
packages/shared     plans & prices (single source of truth), phone normalisation, WhatsApp message builders
scripts/            ui-tour.mjs (screenshots), e2e-ui.mjs (23-step browser test), shoot.mjs
docs/DECISIONS.md   spec/design deviations, open questions, verification status
```

## Tests

```bash
npm test                          # shared + API (needs the local Postgres/Redis; uses the `surveyflow_test` database)
node scripts/e2e-ui.mjs /tmp/e2e # real-browser end-to-end run against the running app on :4222
```

## API (all under `/api`)

`POST auth/register` · `POST auth/login` · `GET|PATCH auth/me` · `GET|POST surveys` · `GET|PUT|DELETE surveys/:id` ·
`POST surveys/:id/{publish,pause,resume,close,duplicate,send,audience,remind,draw}` · `GET surveys/:id/{analytics,responses,recipients,gifts,sync}` ·
`GET surveys/:id/export/{pdf,excel}` · `POST|DELETE surveys/:id/sync/google-sheets` · `GET contacts` · `POST contacts[/import|/bulk-delete|/bulk-tag]` ·
`GET|POST webhook/whatsapp` · `POST payments/initiate` · `GET payments[/:id]` · `GET|POST payments/webhook/:psp` ·
`GET subscription` · `PUT subscription/upgrade` · `POST subscription/{cancel,reactivate}` · `GET|POST whatsapp/accounts…` · `GET integrations/google…`
