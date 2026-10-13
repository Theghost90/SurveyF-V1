# SurveyFlow V1 — decisions, spec corrections and open questions

This file lists every place where the build **departs from the spec or the design**, why, and what is still
**unverified or undecided**. Read §3 and §4 before going live.

Legend: ✅ done and tested here · ⚠️ built, but could not be verified against the real third-party service from the
build environment · ❌ not built in V1.

---

## 1. Spec vs. design: which won

| Topic | Spec (docx) | Design ("SurveyFlow Hero & Pricing") | Used |
|---|---|---|---|
| Plan prices | Starter 9,500 · Growth 29,000 · Business 75,000 FCFA | 14,500 · 39,000 · 95,000 (hero says "from 14,500") | **Spec.** One-line change in `packages/shared/src/plans.ts` if the design numbers are the intended ones. Nothing else needs to move. |
| "First proposal" | — | Hero **A** ("Ask → Hear → Know → Act") and Pricing **A** ("How many voices?") | Those two. |
| Hero CTA "Watch a survey in 60 seconds" | — | No video asset exists | Replaced with "See how it works" (anchor). |
| "Builder Bot & Analytics Bot", "Quick numbers on WhatsApp", "47 new answers on your WhatsApp" | Builder is a **web dashboard**; the only bot command is `START` | Marketed as features | **Removed from the copy** — not built, and selling them would be a false claim. |
| "Keep your WhatsApp Business number (Coexistence)" | Embedded Signup | Marketed | Reworded to "your own WhatsApp Business number". Coexistence needs a specific Meta configuration that I could not verify. |
| `[TO CONFIRM]` placeholders ("Gift budget billed separately", Excel/PDF on Starter) | Starter has exports; gifts are Growth+ | Placeholders | Followed the spec. Who pays for gifts is now decided — the survey owner, via a prepaid wallet (§3.1). |
| Pricing slider ticks | — | Labels 100 / 500 / 3,000 / 15,000 evenly spaced under a **linear** slider, so the "3,000" label sits at 66% while the thumb reaches 3,000 at 19% | **Fixed**: piecewise-linear slider, tier boundaries at even thirds, so ticks and thumb agree. |

## 2. Spec errors found and how they were handled

Each of these is covered by an automated test (see `apps/api/tests`).

### Correctness bugs in the spec's own code/formulas

1. **Gift `switch` has no `break`s** → an airtime recipient would *also* get a discount code, a prize-draw entry and the
   custom message. Each type is handled in exactly one branch; `GiftDelivery` has a unique `(surveyId, contactId)` key so a
   retried webhook cannot pay twice.
2. **`totalSent = COUNT WHERE status IN (sent, delivered)`** excludes everyone who has since started/completed, so "sent"
   *shrinks* as people reply and `noReply = sent − started` goes negative. `status` is funnel *progress*; "sent" is now every
   recipient whose invitation went out. `noReply` = still in sent/delivered (the spec's formula also counts people who tapped
   "Not now" as non-responders). The spec's mock-up numbers don't reconcile either (247 − 189 ≠ 24; 98/167 ≠ 58.7%+…).
3. **Webhook pseudo-code**: reads only `entry[0].changes[0].messages[0]` (Meta batches), reads `interactive.list_reply.id`
   unconditionally (throws for reply buttons, which arrive as `button_reply`), never verifies `X-Hub-Signature-256`
   (anyone could forge answers and trigger gift payouts), has no duplicate-delivery protection (Meta retries), and keys the
   session by the participant's phone only (breaks when one person is surveyed by two businesses). All fixed.
4. **Rating 1–5 "as interactive buttons"** is impossible: WhatsApp allows **3** reply buttons. Ratings are sent as a list.
   Button titles ≤ 20 chars, list rows ≤ 24 chars / 10 rows are enforced in the builder.
5. **Multi-select "WhatsApp Flow"**: Flows need separately published Flow JSON + endpoint. V1 uses a numbered text prompt
   ("reply 1,3"). ❌ Flow-based UI is a later upgrade.
6. **State machine**: spec starts "in_progress" when the participant *answers Q1*. But Q1 is only shown after tapping Start, so
   someone who taps Start and leaves would stay "no reply" forever and **abandonment at Q1 — usually the biggest drop-off —
   would be invisible**. V1 starts on the Start tap. `abandoned → in_progress` (the reminder's "Continue" button) and
   `declined → in_progress` (typing START later) were missing from the spec and are added.
7. **PSP webhook handler** trusts the webhook body's `status: 'success'`, has no idempotency (PSP retries ⇒ the subscription
   is activated and extended twice) and no amount check (under-payment activates the plan). Now: the webhook is only a
   "go look" signal; the outcome always comes from a server-to-server `verifyPayment`, amount and currency are compared,
   and settlement is a compare-and-set on `status = 'pending'`.
8. **PSP router** returns exactly one adapter, so one PSP outage = zero revenue for a country; its XAF/XOF-card rule is
   unreachable after the generic card rule, and it could return an unconfigured/unsupported PSP. Replaced by an ordered
   failover chain filtered by what is configured and what supports the country/method/currency.

### Internal contradictions

9. **Trial → "auto-downgrade to Starter if no payment method"** vs. Starter being a *paid* plan vs. the lifecycle
   `trial → active → past_due → suspended`. Implemented as written (`TRIAL_EXPIRY_POLICY=starter`): the account drops to
   Starter **limits at no charge — effectively a permanent free tier** (3 surveys, 500 responses, 1,000 invitations a month).
   Set `TRIAL_EXPIRY_POLICY=suspend` for a read-only account until paid. **You should decide this** (§3).
10. **"Over limit → 402 at middleware level"** can't work for responses (they arrive through the webhook; there is no client to
    answer 402 to, and dropping a participant's answers mid-survey would be hostile) and the pricing says responses beyond the
    plan cost 500 FCFA per 100 — i.e. they are *billable*, not blocked. So: active surveys → 402 at publish/resume;
    messages → 402 at send time (where they cost money); responses → never blocked, shown as overage.
11. **"WhatsApp messages / month" (1,000)** can't mean every outbound message: a 3-question survey sends ~5 messages per
    participant, so 500 responses would need 2,500. Defined as **business-initiated (template) messages** — invitations,
    reminders, out-of-window gift notices — which is also what Meta charges for and gives the intended ~2:1 invitation:response ratio.
12. **Tech Provider vs. "Meta cost + 15% margin"**: as a Tech Provider each business pays Meta directly, so a pass-through
    margin is only possible as a Solution Partner/BSP. Overage billing of messages is **not automated** (usage is counted and shown).
13. **Cross-references**: the spec points to "Section 13" for payments; it is Section 9.
14. **Thank-you and gift messages as templates** (§3.2) are unnecessary inside the 24 h window the participant just opened
    (free-form is free and simpler). Templates are used only for the invitation, the reminder, and out-of-window gift notices.
    Templates are also **per-WABA** (the "library of pre-approved templates" can't be shared), so each connected account
    submits its own copies and tracks approval.

### Additions the spec didn't ask for but needs to be safe/legal

- **Opt-in & STOP**: WhatsApp policy requires opt-in. CSV import and manual entry need an explicit consent attestation
  (stored with a timestamp); `STOP` opts a contact out and cancels queued sends; only imported contacts can interact.
- **Questions freeze on publish** — editing labels/options afterwards would silently change what collected answers mean.
  "Duplicate to edit" is the supported path.
- **Send queue** (DB, `FOR UPDATE SKIP LOCKED`) with per-number throttling and backoff — a single blast would exceed Meta's
  messaging tiers. **Gift safety**: ambiguous provider failures (timeouts) are *never* auto-retried (a retry could pay twice);
  per-survey gift cap; no gift automation on the free trial (a free trial that can pay out is a farming vector).
  **Gift money is the owner's, not ours**: a prepaid gift wallet is debited atomically when a participant completes (§3.1).
- **Security**: tokens AES-256-GCM encrypted at rest; login rate-limited per (email, IP) *and* per account; the API never trusts
  a client-sent price; participants' free text is HTML-escaped in the PDF, written as text cells in Excel and with
  `valueInputOption=RAW` in Google Sheets (no formula injection); the PDF renderer blocks all network requests.
- **Schema additions** (all in `apps/api/prisma/schema.prisma`, marked `ADDED`): `SurveyRecipient.queued/failed/startedAt`,
  `SendJob`, `MessageTemplate`, `MessageLog`, `PrizeDrawEntry`, `GoogleConnection`, `SheetSync`, `SheetRow`,
  `Survey.language/customThankYou/giftAmountFCFA/giftMaxCount/scheduledAt`, `Contact.consentAt/optedOutAt`,
  `Subscription.interval/cancelAtPeriodEnd/graceEndsAt`, `PaymentTransaction.reference/plan/method/…`. The spec's `Session`
  lives in Redis only; SQL (`SurveyRecipient` + `Response`) is the durable truth so a lost Redis is recoverable.
- **Extra environment variables** the spec's list is missing but the code cannot work without: `JWT_SECRET`,
  `TOKEN_ENCRYPTION_KEY`, `META_APP_SECRET` (**without it webhook signatures cannot be verified**), `META_APP_ID`,
  `META_EMBEDDED_SIGNUP_CONFIG_ID`, `PAYUNIT_API_USERNAME`, `FLUTTERWAVE_WEBHOOK_HASH`, `NOTCHPAY_WEBHOOK_HASH`,
  `CAMPAY_WEBHOOK_KEY`, `PUBLIC_API_URL`, `WEB_ORIGIN`, `API_URL`, … See `.env.example`.

## 3. Open business decisions (need an owner)

1. **Who pays for gifts? — DECIDED: the survey owner (SurveyFlow's customer), and the owner chooses per survey whether to
   offer a gift at all.** Implementation and what it leaves open: §3.1 below.
2. **Free-tier economics** under `TRIAL_EXPIRY_POLICY=starter` (see §2.9).
3. **Meta category.** Survey invitations are declared `UTILITY` (per spec). Meta may re-categorise mass survey invitations as
   `MARKETING`, which is priced differently — check the per-message cost against the 9,500 FCFA Starter before launch.
4. **Prices** (§1) and whether Starter should include PDF/Excel export (spec: yes; the design had `[TO CONFIRM]`).
5. **Overage invoicing** (500 FCFA / 100 responses; messages pass-through) is displayed but **not billed automatically**.
6. **Legal pages** (`/privacy`, `/terms`) are *drafts describing what the software does* and are labelled as such. Counsel must
   replace them. The data-protection reference (Cameroon Law No. 2024/017) should be confirmed by counsel.

### 3.1 Resolved: the survey owner pays for gifts (prepaid gift wallet)

**Why a prepaid wallet and not "invoice afterwards":** Mobile Money has no card-on-file. Billing the owner after the fact means
SurveyFlow pays participants first and chases the owner for the money, which is exactly the exposure the answer was meant to remove.

**How it works**

- Gifts are **opt-in per survey** (default "No gift"). Only airtime and Mobile Money cost money; discount codes, prize draws
  and thank-you messages are free to everyone. Paid gifts need a plan with gift automation (Growth+).
- The owner tops up an **FCFA wallet** (2,000–1,000,000) through the same PSP layer as subscriptions (failover,
  verify-with-the-PSP-before-credit, idempotent settlement, amount check). Charged in XAF/XOF 1:1, so no FX rate is invented.
  An over-payment credits only the amount asked; an under-payment is rejected.
- When a participant completes, **the gift is debited in the same database transaction that marks them completed**
  (`UPDATE … WHERE balance >= cost`, one statement — concurrent completions cannot overspend). Only then does the thank-you
  promise the gift. **If the wallet cannot cover it, the participant gets a plain thank-you** (never a promised gift we cannot pay)
  and the gift is parked as `unfunded`.
- **Unfunded gifts are released by the owner explicitly** ("Pay these gifts" in analytics), never automatically: a top-up meant
  for survey B must not be silently spent on survey A's backlog. They are announced with the approved template (the 24 h
  window is closed by then).
- **Refunds:** a *definite* provider rejection (after 3 attempts) refunds the wallet, and the refund amount comes from the
  ledger (what that gift actually holds), so a gift that was never charged can never mint balance. An **ambiguous** failure
  (timeout after sending) keeps the debit, is never auto-retried (a retry could pay twice) and is shown as "to verify".
- **Cost shown before commitment:** unit cost (amount + fee), balance, how many gifts it covers, and the highest possible spend
  (cap × unit cost) in the builder; the send panel previews worst-case exposure for the exact audience. Publishing or sending
  with too little balance is **allowed but never silent** (warning, not a block — the owner may top up right after).
  Owners get one "wallet is empty" WhatsApp notice per day when participants were left unrewarded.
- **Integrity:** `balance == sum(ledger)` and `balance >= 0` are asserted after every wallet test; the balance also has a
  database `CHECK (>= 0)`. Surveys and contacts with a debited, undelivered gift cannot be deleted (the cascade would erase the
  money trail).

**What this decision opens (all need an owner — none are solved by code):**

1. **The fee is a placeholder.** `GIFT_FEE_PERCENT` defaults to 5 % to cover payout + collection costs. The real PSP/Campay tariffs
   are unknown here. At 0 % SurveyFlow silently loses money on every gift; set it from the actual contracts before launch.
2. **Holding customer money and paying third parties may be a regulated activity** (e-money / payment-services rules in CEMAC and
   UEMOA). Whether a prepaid, spend-only wallet needs a licence or must be run through a licensed partner is a question for counsel,
   not for the code. Do not launch paid gifts before it is answered.
3. **Treasury float.** Top-ups arrive in the PSP accounts that collect them; payouts leave from the gift provider's balance.
   The sum of all wallet balances is a liability SurveyFlow must be able to cover. Monitor
   `SELECT sum("giftBalanceFCFA") FROM "User"` against the provider balance. There is no automatic reconciliation.
4. **Unspent balance cannot be withdrawn in V1** (and a top-up is refused on plans without gift automation, so a lapsed plan
   cannot strand new money). Refund policy for leftover balance is a legal/commercial call.
5. **"To verify" gifts have no resolution screen.** Support must check the provider by reference (`sf-gift-<id>`) and then
   refund or confirm by hand; there is no admin UI in V1.
6. **Unfunded gifts do not expire.** An owner can release a months-old backlog; the participant then receives an unexpected gift
   notice. Consider a cut-off (e.g. 30 days).
7. **Payout path is still unverified** (§4): the Campay airtime / Mobile Money calls were written from documentation. With the
   owner's money now behind them, they must pass a sandbox run before real funds are accepted.

## 4. What is verified and what is not

**Verified in this environment** (real Postgres + Redis + headless Chromium):
105 automated tests (20 shared + 85 API: state machine, signed + duplicate + concurrent webhooks, abandonment/resume, STOP, analytics, gifts, the gift wallet (guarded debit under parallel completions, refunds, release/retry double-clicks, deletion guards),
plan limits, payments incl. forged/under-paid/duplicate webhooks, failover, lifecycle, Excel/PDF/Sheets with Google stubbed),
a 23-step real-browser end-to-end run (register → onboarding → builder → publish → send → simulated participant →
analytics → PDF/Excel download → mock checkout → FR/EN → mobile widths), a 12-step wallet run (`scripts/e2e-wallet.mjs`: empty wallet →
warnings → participant finishes unpaid → top-up → release → delivered with a template notice → FR → mobile), both DB migrations applied
from scratch (no drift; the `CHECK (balance >= 0)` rejects an overdraw), and the production bundles. Several tests were
mutation-checked (disabling the dedupe, lock, signature check, amount check, the wallet's balance guard, the release/retry
compare-and-set or the ledger-based refund makes the matching test fail — one wallet test was first found vacuous this way and fixed).
The browser runs print benign `Failed to fetch RSC payload` / `CLIENT_FETCH_ERROR` console lines from prefetches aborted by rapid
navigation in the mobile steps (no 5xx anywhere); not verified against the pre-wallet build.

**Written from documentation but NOT exercised against the real service** — the build environment has no credentials and
its network policy blocks these hosts. Treat each as "needs a sandbox pass":

| Area | Risk |
|---|---|
| Meta Cloud API client, Embedded Signup flow, template submission/approval, status webhooks | Payload shapes follow Meta's public docs; never sent to Meta. |
| Flutterwave v3 | Endpoints confirmed by documentation search; not called. |
| Notch Pay, CinetPay | Init/verify endpoints confirmed by documentation search; **webhook signature schemes are unconfirmed** (safe default: bad signature ⇒ rejected; the status poll still activates paid subscriptions). |
| **Campay, PayUnit** | **Lowest confidence**: paths/fields written from memory (PayUnit's endpoint paths and Campay's airtime endpoint especially). Do not enable without sandbox verification. |
| Campay airtime/MoMo gifts | The spec says Campay can send airtime; the endpoint used is unverified. **Higher stakes now: owners' prepaid money is what pays through it.** |
| Gift fee, wallet legality, treasury float | Not code questions — see §3.1 items 1–3. |
| Google OAuth + Sheets | Implemented on plain REST; exercised only with Google stubbed. |
| Puppeteer on Docker/Fly/Railway | Works here with the bundled Chromium; the Dockerfile installs `chromium` but has not been built (no Docker daemon). |

## 5. Not built in V1 (❌)

Team members (1/3/10), API access, white-label (sold on the plan table, shown as **"soon"**) · Builder Bot / Analytics Bot ·
daily summary e-mail and "50% completed" WhatsApp alert (shown disabled) · WhatsApp Flows · "Download receipt" button ·
automated overage billing · proration on plan changes (an upgrade starts a new period; downgrade = cancel and re-subscribe) ·
the funnel uses accessible CSS bars rather than a Recharts `FunnelChart` (per-question charts use Recharts).
