# SurveyFlow V1 — decisions, spec corrections and open questions

This file lists every place where the build **departs from the spec or the design**, why, and what is still
**unverified or undecided**. Read §3 and §4 before going live.

Legend: ✅ done and tested here · ⚠️ built, but could not be verified against the real third-party service from the
build environment · ❌ not built in V1.

---

## 1. Spec vs. design: which won

| Topic | Spec (docx) | Design ("SurveyFlow Hero & Pricing") | Used |
|---|---|---|---|
| Plan prices | Starter 9,500 · Growth 29,000 · Business 75,000 FCFA | 14,500 · 39,000 · 95,000 (hero says "from 14,500") | **Design prices — owner decision (2026-10-15).** Changed in `packages/shared/src/plans.ts`; seed, tests and e2e updated. Non-FCFA prices are no longer typed in: they are these FCFA prices at a live exchange rate (§3.3, "Multi-currency money"). Annual = 10 × monthly (145,000 / 390,000 / 950,000). |
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
3. **Meta message categories — NOT yet handled in code.** The owner's position: Meta will bill some survey invitations as
   *marketing* and others as *utility*. The code still declares every template `UTILITY` (blueprint) and has no way to pick a
   category per survey, to submit a marketing variant, or to follow Meta's re-categorisation. Needed: a per-survey choice
   (e.g. "feedback on a recent transaction" = utility, "unsolicited / promotional" = marketing) mapped to two template
   families, status handling when Meta re-categorises, and a cost warning in the send panel. The Meta page quoted for this
   (`messenger-platform/.../utility-messages`) is for **Messenger**; WhatsApp has its own category rules — confirm against the
   WhatsApp Business Platform docs before building. Check per-message cost against the 14,500 FCFA Starter before launch.
   **Automatic reminders and closing notes (§3.3) add more template messages to this question.**
4. **Prices** — decided (§1: 14,500 / 39,000 / 95,000 FCFA); non-FCFA prices are live conversions (§3.3); still open: whether Starter should include PDF/Excel export (spec: yes; the design had `[TO CONFIRM]`).
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

### 3.2 Blueprint features found missing or different (reviewed 2026-10-15)

All three items found in that review (automatic abandoner reminder, currency by geolocation, "Download receipt") are now built — see §3.3 for what
was built, the choices behind it and what is still open.

### 3.3 Reminders, geolocation, multi-currency money, PSPs, API lockdown, receipts, customer segment (built 2026-10-15/16)

**Automatic reminders** (`packages/shared/src/reminders.ts` = the rules as pure functions; `apps/api/src/services/reminders.ts` = the engine, run every 5 min).
The owner does not choose *when*: the rules exist so that nobody gets chased the day after an invitation.

| | Non-responders (invited, never tapped Start) | Abandoners (started, silent ≥ 24 h) |
|---|---|---|
| Standard | ONE reminder, 3–5 business days after the invitation | ONE reminder, ≥ 2 business days after the survey reached them (never before they were flagged abandoned), window +1 business day |
| Event (kind = `event`, deadline within 7 days of the invitation) | ONE reminder 24 h after the invitation | ONE reminder as soon as they are flagged |
| Closing note | Event only: 24 h after the reminder if still no answer — short note, "you still have until {deadline}" | Always: 24 h after the reminder if not finished — thanks, "your progress is saved" (event version mentions the deadline) |

Each switch (per survey, per profile) is **off by default**; switching one on shows the owner the exact promise ("a single automatic reminder in 3 to 5 business days… and
a single 24-hour reminder if the survey is about an event that will happen soon" / "2 to 3 business days…"). Survey **type** (general / event) and **deadline** (a calendar date
= end of that day in the owner's time zone; required for events; the survey closes by itself at the deadline) are captured in the builder's "Timing & reminders" card.
Choices that are mine, not the brief's — change them if wrong:
- **The closing note is a second message to the same person.** The brief says "a single reminder" *and* asks for a note 24 h later; I built both and disclose it in the
  switch's explanation. Hard cap: 1 reminder + 1 closing note per person (compare-and-set on `remindedAt` / `followupAt`, so two workers or a restart cannot double-send).
- Non-responders under the standard rule get **no** closing note (the brief asked for one only in the event rule).
- Sending is limited to 08:00–19:00 in the owner's country (fixed UTC offsets; none of the supported countries has DST); the standard rule only on weekdays. **Public holidays are not modelled — decided by the owner: leave it as is.**
- A reminder whose window has passed (worker down, quota empty) is **dropped, never sent late**. Each reminder uses one unit of the plan's WhatsApp message quota.
- The event rule applies only if the invitation went out within 7 days of the deadline; an earlier invitation follows the standard timing (said in the UI).
- Never sent to opted-out contacts or contacts without consent, to paused/closed surveys, or when the switch was turned off in the meantime (this also stops pending closing notes).
- **The manual "Remind non-responders / abandoners" buttons follow the same clock (decided by the owner).** They are disabled until the person's automatic window has opened (3 business days after the invitation, 2 after an abandonment,
  24 h for a live event) and enforced by the API (`409 reminder_not_yet`, with the date it opens). Once open, an owner may remind at any time, still once per person (same compare-and-set claim, same templates as the automatic reminder;
  a manual reminder never triggers the automatic closing note). A person whose window can never open (deadline too close) cannot be reminded by hand either. The analytics page says who is waiting and until when.
- **Reminder messages are MARKETING templates (decided by the owner).** `survey_reminder`, `survey_nudge`, `survey_deadline_note`, `survey_progress_saved`, `survey_progress_saved_deadline` (en + fr) are declared `MARKETING`; invitations and the gift notice stay `UTILITY`.
  Consequences: Meta bills reminders at its marketing rate (higher than utility) and may cap how often one person can receive marketing messages — the switches' explanation tells the owner so. **Meta fixes a template's category when it is created:** a WhatsApp
  account that already submitted these templates as UTILITY must delete and resubmit them (there is no live account yet). The invitation's own category question (§3 item 3) is still open.
  They must be approved by Meta like the others.

**Geolocation → currency, price, phone format.** No IP database is bundled (the free ones carry licence terms). The site reads the country header that the platform in front of it already
sets (`x-vercel-ip-country`, `cf-ipcountry`, `cloudfront-viewer-country`); behind none of them (localhost, a bare VPS) the country is *unknown* and everything falls back to **Cameroon / FCFA**.
Local testing: `DEV_GEO_COUNTRY=NG` (ignored in production builds). Unsupported countries (anything outside the 18 in `COUNTRY_CONFIG`) are also treated as Cameroon / FCFA.
- The web server forwards the country to the API as `x-sf-country` only when known; the API believes it **only on a request that carries the website's shared secret** (see "API lockdown" below), so a client cannot forge its own country.
- The owner's country/currency **follow their location until the first money moves, then lock**: a successful payment, a wallet in some currency, or a wallet top-up in flight (a paying customer's price must not move because they travelled or used a VPN).
- Profile → "Currency" is read-only and shows the country with its official currency ("Cameroon (XAF)"). There is no country, currency or payment-provider field anywhere in the owner UI.
- Phone examples/prefixes (register form, settings, billing and top-up dialogs, contact forms and CSV sample, error messages) follow the owner's country; the example numbers were validated with libphonenumber.

**Multi-currency money (decided by the owner; replaces the earlier FCFA-only wallet and placeholder prices).**
- *Prices.* The canonical prices stay 14,500 / 39,000 / 95,000 FCFA. Every other currency is the FCFA price × a **live rate**, never a number typed into the code: pricing page, home page, billing, onboarding, overage and wallet limits all use it. Rounded to
  3 significant digits from 1,000 up and to whole units from 10 up (≤ ~0.5 % off the exact conversion above 1,000, ≤ 2 % around 25), annual = ten months converted once. One display style everywhere: "34,800 NGN".
- *Rate source.* ExchangeRate-API's open endpoint (`open.er-api.com/v6/latest/XAF`: no key, covers NGN KES GHS USD GBP ZAR UGX, refreshed once a day, free for commercial use **with attribution**, which every converted price carries). Google has no public rate API, so it is
  not used. Override with `FX_API_URL` (same response shape). XAF/XOF are 1:1 and EUR is the fixed peg (655.957), so they never need a live rate. Rates are cached in Redis (`FX_CACHE_MINUTES`, default 360), refreshed every 3 h by the scheduler, and every accepted
  table is stored in `FxRate` as the last-known-good copy. A table older than `FX_MAX_STALE_HOURS` (72) is **not used**; a rate that jumps > 50 % from the previous one is rejected as bad data. **No fresh rate ⇒ prices are shown and charged in FCFA with an explicit
  notice — an invented conversion is never served.** Top-ups pause (503 `fx_unavailable`) instead of guessing; a gift whose payout cannot be converted waits (still debited) and goes out when a rate is back.
- *Charging.* The owner pays in **their currency** (the amount we display), by **international card** only: Mobile Money (MTN MoMo / Orange Money) exists only in CFA francs, so outside the FCFA zone it is not offered (and refused by the API). The providers settle to SurveyFlow
  in XAF. The currency list the providers can charge in is the owner's: XAF, XOF, ZAR, GHS, KES, NGN, UGX, USD, GBP, EUR (Campay: XAF only, it is Cameroon mobile money). The euro is priced at the CFA franc's **fixed peg** (655.957), so it needs no live rate and carries no
  ExchangeRate-API attribution (the note says "fixed peg" instead). **No supported country uses EUR (nor USD, GBP, ZAR, UGX) yet**: `COUNTRY_CONFIG` has CFA countries, Nigeria, Kenya and Ghana only, and every other visitor (France, the US …) still gets Cameroon / FCFA. Those currencies are
  chargeable but unreachable until countries are added — which is a separate decision (see "Open" below).
  Each payment records the XAF the provider will settle for the amount charged (`amountXAF`, the amount converted back at the rate used — the same meaning for subscriptions and top-ups) and the rate (`fxRate`); the subscription itself is recorded at its canonical FCFA price (`amountFCFA`).
  **Two of the owner's statements conflict and I chose one:** "the merchant receives the exact amount in XAF" (charge in XAF, let the provider show the buyer a converted figure) versus "pay the plan in naira / shillings" (charge in the buyer's currency). I charge in the buyer's currency, so the buyer pays
  exactly the figure we showed and the provider's own conversion decides the XAF that lands: **SurveyFlow bears the difference between our rate and the provider's** (usually small, never zero) — reconcile against the provider statements. Switching to "charge XAF" is a small change; say so.
- *Wallet and gifts in the owner's currency.* The wallet balance, top-up limits and presets, the gift amount, its limits (100–20,000 FCFA converted and tidied: e.g. 200–50,000 NGN, 20–5,000 KES), the fee, the ledger, refunds, analytics, the cost panel and the receipt are all in the owner's wallet currency (whole units). The **first top-up fixes the
  wallet's currency** (enforced inside the SQL update); a second top-up in another currency is refused. Gift amounts are only ever set after a paid plan, i.e. after the currency has locked.
- *Gift payout.* The payout provider (Campay) speaks **CFA francs only**: each gift is converted to XAF at the live rate just before sending, that amount is pinned on the row (retries never re-quote), and the receipt shows both ("500 NGN … value delivered 208 FCFA").
  **Open risks you should weigh: (1) SurveyFlow carries the exchange-rate risk between a customer's top-up and the payout; (2) Campay pays Cameroonian MTN/Orange numbers only — a Nigerian or Kenyan owner's participants cannot receive airtime through it, so such gifts will fail and be refunded until a provider for those countries is integrated; the plumbing
  (currency, conversion, refund) is in place, the rail is not.** "We'll start selling in Cameroon" makes this latent, not urgent. **Owner's decision (2026-10-15): accepted as is** — the wallet UI keeps letting a non-CFA owner top up and send gifts; a definite payout failure refunds the wallet, an
  ambiguous one is held for manual check (§ gifts), as before.
- **Open — adding countries outside the current list** (France/euro zone, US, UK …) so that EUR/USD/GBP are actually reachable: (a) `utcOffsetMinutes` is a fixed offset ("none of these countries observes DST"), which is wrong for Europe/US and would shift the 08:00–19:00 reminder window by an hour half the year;
  (b) amounts are whole units, and for a currency worth 656 FCFA a unit is coarse: the smallest gift is 1 EUR (≈ 656 FCFA vs 100 FCFA at home) and the percentage fee is rounded **up** to a whole unit (5 % of a 1-EUR gift costs 1 EUR, so the gift costs 2) — minor units (cents) would be needed first;
  (c) mobile-money lists, phone prefixes and the onboarding country choice for each new country.
- Owner-facing amounts that are not money (response counts, message quotas) are unchanged. The hero chat demo still shows a "500 FCFA airtime" bubble (illustration).

**PSPs: contract fees, automatic choice, CamerPay.** Owners never see or choose a provider. Per payment, among providers that are configured and support the buyer's country (mobile money) or any country (cards, which are international), the currency and the method, the **cheapest for this payment** comes first and the rest remain as failover.
Cost = percentage + fixed part on the payment's FCFA value (a $0.30 fixed fee matters on 14,500 FCFA: NotchPay's card ≈ 5.1 % there, dearer than Flutterwave's 4.8 %, though cheaper on a large payment). Fixed parts are converted with cached rates only: choosing a provider never waits on the network.
Fees come from the owner's "PSPs contract fees" document (`packages/shared/src/psp-fees.ts`), overridable per provider and method with `PSP_FEES` (a number = percent, or `{"percent":3.9,"fixed":0.3,"fixedCurrency":"USD"}`):

| PSP | Mobile money | Cards | Setup / fixed | Used in ranking | Source |
|---|---|---|---|---|---|
| **CamerPay** | 1.0–3.0 % by plan: Starter 0 XAF/mo 3.0 % (max 100 tx/mo) · Business 500 XAF/mo 1.5 % · Pro 2,500 XAF/mo 1.0 % · Pro BYOK (own Orange/MTN keys) 0 % | Stripe (~2.9 % + €0.25) or PayPal (~3.49 % + €0.49) added to the buyer's checkout, + plan commission | free tier; paid plans 500–2,500 FCFA/mo; withdrawals from 1,000 FCFA | MoMo = plan % (`CAMERPAY_PLAN`, default Starter); card = plan % + 2.9 % + €0.25 | [camerpay.biz](https://camerpay.biz/) · [docs](https://camerpay.biz/docs/) · [payment methods](https://camerpay.biz/moyens-de-paiement?lang=en) |
| **NotchPay** | 1.0 % | 3.9 % + $0.30 | free, 0 XAF/mo; payouts 1.0 % | 1.0 % / 3.9 % + $0.30 | [notchpay.co/pricing](https://www.notchpay.co/pricing) |
| **CamPay** | 2.0 % | not natively supported | free, 0 XAF/mo; withdrawals 1.0 % (mobile) or 5,000 FCFA (bank) | 2.0 % / — | [campay.net](https://www.campay.net/fr/) |
| **CinetPay** | 2.0–2.5 % | 3.5 % | free registration; monthly fees may apply to advanced plans; withdrawals 1.0–2.0 % (1.5 % flat above 5,000 concurrent transfers) | 2.5 % (upper bound) / 3.5 % | [cinetpay.com/pricing](https://cinetpay.com/pricing) |
| **Flutterwave** | 2.0 % | 4.8 % (local & international) | free, 0 XAF/mo; payouts 1,500 FCFA (bank) or 1.0 % (mobile) | 2.0 % / 4.8 % | [flutterwave.com/cm/pricing](https://flutterwave.com/cm/pricing) |
| PayUnit | not in the document | not in the document | — | no fee known: ranks after those that have one | — |

Judgement calls: CinetPay's range uses its upper bound; CamerPay's card cost counts the Stripe component even though the buyer pays it (it makes the provider dearer for the buyer); payout/withdrawal fees are not collection costs and are not used; CamerPay's plan is a contract choice (`CAMERPAY_PLAN`).
Default order for a Cameroon mobile-money payment: NotchPay, Campay, CinetPay, CamerPay (Starter), PayUnit.

*CamerPay adapter* (`services/payments/adapters/camerpay.ts`; docs https://camerpay.biz/docs/). Built from the public documentation pages and an SDK that could be read through search; **the hosts were not reachable from the build environment, so nothing was sent to CamerPay and it is "lowest confidence" like Campay/PayUnit.**
Followed: `POST {base}/api/payment/initiate`, Bearer key, `invoice_id` = our reference, `merchant_callback_url` / `merchant_return_url`; webhooks = form-encoded POST with `X-CamerPay-Signature` = hex HMAC-SHA256 of the **string `uuid|invoice_id|status|amount`** (amount with two decimals, not the raw body) keyed with the dashboard's callback secret; statuses completed / failed / refunded.
Not known, therefore not guessed: a server-side "get transaction" endpoint (so the **signed webhook is the outcome** — verified, stored, then settled through the common path with its amount check; a lost webhook leaves the payment pending until it expires after 24 h, re-send it from the dashboard — replays are idempotent), the `payment_method` value per mobile-money operator (left out so the hosted page asks Orange or MTN), and whether the pages' `callback_url` vs `merchant_callback_url` naming is current.
Needs `CAMERPAY_API_KEY` **and** `CAMERPAY_WEBHOOK_SECRET` (the adapter is not offered with only one). The signed string has no currency, so the currency check is "the amount must cover what we asked in the currency we asked".

**API lockdown (decided by the owner).** When `INTERNAL_API_SECRET` is set the API refuses with 403 every request that does not carry it in `x-internal-secret`, **except** four public paths that other parties must reach: `/healthz`, Meta's `/api/webhook/whatsapp`, the providers' `/api/payments/webhook/<psp>` and participants' `/api/receipts/<token>`
(each protected by its own signature or signed token; the path matching is strict: no traversal, no extra segments). Only the website's server holds the secret: its proxy, its sign-in calls and its pricing fetch attach it, and the browser never sees it. The visitor's country (`x-sf-country`) is believed only on such a request, so it cannot be forged.
Production refuses to start without a 32+ character `INTERNAL_API_SECRET` and without an **https, non-local `PUBLIC_API_URL`** (receipt links and PSP/Meta callbacks are built from it). This is the application-level half; the network-level half (private network / firewall admitting only the website plus those four paths) is a deployment setting — see `deploy/fly.api.toml`.
A fully private network would also hide the three callback paths from Meta and the providers, so it needs a public proxy for them.

**Download receipt (proof of gift).** Airtime / MoMo gifts only (prize draws, discount codes and custom gifts have no delivery to prove). The link exists only after the gift status is `sent`: in the participant's WhatsApp confirmation
(text link in immediate mode; a "Download receipt" URL button on the `survey_gift_notice` template in batch/out-of-window mode) and in the owner's analytics ("Delivered gifts"). The link is a capability URL
`/api/receipts/<giftId>.<HMAC>` (no login: participants have no account); a bad/forged/undelivered token returns the same generic 404. The PDF shows survey, gift, amount, masked phone, date and a reference — **not** the owner's fee or wallet.
It is a delivery receipt, **not a tax invoice** (the page says so). Receipt links are built from `PUBLIC_API_URL`, which the API now **validates at production startup** (https, not localhost/private); for an owner outside the FCFA zone the receipt shows the amount in their currency and the CFA value delivered. The blueprint's "no external links" principle is relaxed for this one link.

**Customer segment (Businesses / Institutions / Academics).** Asked as the first, required step of onboarding (setup cannot be marked done without it — enforced by the API; any account without a segment, including pre-existing ones, is sent to that
step before anything else) and editable in Settings. **It currently changes nothing else**: the blueprint does not say which "additional features" each segment gets, and I will not invent them. Candidates if you want to pick:
Businesses — satisfaction/NPS/delivery templates, gifts, customer tags; Institutions — consent & anonymity wording, beneficiary/member tags, multilingual surveys, quotas by area; Academics — consent text, anonymous mode,
quotas, SPSS/CSV export with a codebook, question-type extras. Tell me which, and where they should appear (builder, templates, send panel).

## 4. What is verified and what is not

**Verified in this environment** (real Postgres + Redis + headless Chromium):
227 automated tests (56 shared + 171 API: state machine, signed + duplicate + concurrent webhooks, abandonment/resume, STOP, analytics, gifts, the gift wallet (guarded debit under parallel completions, refunds, release/retry double-clicks, deletion guards),
plan limits, payments incl. forged/under-paid/duplicate webhooks, failover and fee ranking, lifecycle, Excel/PDF/Sheets with Google stubbed, **automatic reminders** (every rule to the minute on a simulated clock, once-only under two parallel workers,
switches, quota, opt-out, deadlines), **geolocation** (country → currency/prices/phone format, lock after first payment, unknown/unsupported → FCFA), **receipts** (only for delivered gifts, forged/tampered tokens, masked phone, no fee, escaped text) the segment gate, **live exchange rates** (cache, single flight, stale limit, bad-jump rejection, garbage from the source), **multi-currency** plans / wallet / gifts (naira and shillings, limits, card-only, payout conversion and pinning, outage behaviour, refunds, currency lock), **PSP fee ranking** with the documented fees,
**CamerPay** (request shape, signed webhooks: forged / tampered / under-paid / replayed), **the API lockdown** (which paths are public, traversal attempts) and **manual-reminder gating**),
a 29-step real-browser end-to-end run (register → required segment step → onboarding → builder incl. the Timing & reminders card → publish → send → simulated participant → analytics → PDF/Excel download → mock checkout → settings
(Currency read-only, no provider/country picker) → an unreadable API response no longer white-screens the app → geolocated visitors: unknown/US see FCFA, Nigerian sees NGN prices and a +234 form and signs up as "Nigeria (NGN)" → FR/EN → mobile widths), a 6-step Kenyan-owner run (`scripts/e2e-currency.mjs`: pricing in shillings with the rate note → sign-up → plan paid by card in KES → wallet and gift limits in KES → French), run with the **API lockdown switched on** (the browser tests go through the real secret-carrying proxy), a 12-step wallet run
(`scripts/e2e-wallet.mjs`: empty wallet → warnings → participant finishes unpaid → top-up → release → delivered with a template notice **and a receipt that opens a real PDF, while a tampered link 404s** → FR → mobile), all four DB migrations applied
from scratch (no drift; the `CHECK (balance >= 0)` rejects an overdraw), and the production bundles. Several tests were
mutation-checked (disabling the dedupe, lock, signature check, amount check, the wallet's balance guard, the release/retry
compare-and-set, the ledger-based refund, the reminder once-only claim, the switch check, the "delivered gifts only" receipt rule, the receipt signature check, the segment gate, the send worker's oldest-first ordering, the manual-reminder window check, the lockdown gate and its public-path pattern, the FX bad-jump and staleness rules, the payout conversion, the card-only rule, the wallet-currency guard or the CamerPay signature check makes the matching test fail — one wallet test and one reminder test were first found vacuous this way and fixed).
One real bug was found by the full-suite run and fixed: `UPDATE … RETURNING` does not keep the claim query's `ORDER BY`, so a worker that claimed a reminder and its closing note in one batch could send the note first; the worker now processes claimed jobs oldest-first (test forces the adversarial row order).
A second real bug came out of the browser run and was fixed: a *successful* API response whose body was cut off was parsed as `{}`, cached as the account, and crashed the whole app ("Application error") on `account.user.…`; `api()` now treats an unreadable success as a network failure (regression step in the e2e).
The browser console check ignores one known artefact: Next's `Failed to fetch RSC payload … Falling back to browser navigation` (and next-auth's matching `CLIENT_FETCH_ERROR`) printed when the test's hard `page.goto()` aborts an in-flight link prefetch
(reproduced in isolation as `net::ERR_ABORTED`); any other console error or 5xx still fails the run.
**Geolocation was exercised by sending the CDN header from the test browser**, not behind a real CDN.

**Written from documentation but NOT exercised against the real service** — the build environment has no credentials and
its network policy blocks these hosts. Treat each as "needs a sandbox pass":

| Area | Risk |
|---|---|
| Meta Cloud API client, Embedded Signup flow, template submission/approval, status webhooks | Payload shapes follow Meta's public docs; never sent to Meta. **Runnable check: `scripts/meta-check.mts` (`docs/META_CHECK.md`) — not yet run by the owner against a real Meta app** (the build environment cannot reach Meta). Tech Provider status (business verification + app review) and the Embedded Signup popup cannot be scripted. |
| Flutterwave v3 | Endpoints confirmed by documentation search; not called. |
| Notch Pay, CinetPay | Init/verify endpoints confirmed by documentation search; **webhook signature schemes are unconfirmed** (safe default: bad signature ⇒ rejected; the status poll still activates paid subscriptions). |
| **Campay, PayUnit** | **Lowest confidence**: paths/fields written from memory (PayUnit's endpoint paths and Campay's airtime endpoint especially). Do not enable without sandbox verification. |
| Campay airtime/MoMo gifts | The spec says Campay can send airtime; the endpoint used is unverified. **Higher stakes now: owners' prepaid money is what pays through it.** |
| Gift fee, wallet legality, treasury float | Not code questions — see §3.1 items 1–3. |
| Reminder / closing-note templates and the receipt URL button | New templates (`survey_nudge`, `survey_deadline_note`, `survey_progress_saved[_deadline]`, `survey_gift_notice` with a URL button) have never been submitted to Meta; the URL-button payload follows Meta's documented component shape. Meta may re-categorise the reminders as marketing (§3 item 3). Inside the 24 h window the sent-notice is an interactive `cta_url` message (button + link, no raw URL in the text), written from Meta's documentation and never sent to Meta; outside it, the template's URL button. |
| NGN / KES / GHS / USD / EUR settlement | Prices are live conversions now (not placeholders); that each PSP can charge in these currencies is the owner's statement, not something tested (see "Provider currencies"). |
| **CamerPay** | Adapter written from public documentation pages; the host was unreachable from the build environment, so no request was ever sent. Initiate path/fields, the webhook signing string and field names must be confirmed in the sandbox/dashboard (the pages disagree on `callback_url` vs `merchant_callback_url`); there is no known status endpoint, so settlement relies on the webhook. |
| Live exchange-rate source | `open.er-api.com` was not reachable from the build environment either: the service is exercised against a stub with the documented response shape (and the browser runs against `scripts/fx-stub.mjs`). Check one real fetch before launch. |
| Provider currencies | The owner states the providers accept XAF, XOF, ZAR, GHS, KES, NGN, UGX, USD, GBP and EUR (EUR confirmed 2026-10-15); this is taken as given and never tested against a provider account. |
| Provider fees | Taken from the owner's contract-fee document, not from the providers' live pricing pages (not reachable). |
| Google OAuth + Sheets | Implemented on plain REST; exercised only with Google stubbed. |
| Puppeteer on Docker/Fly/Railway | Works here with the bundled Chromium; the Dockerfile installs `chromium` but has not been built (no Docker daemon). |

## 5. Not built in V1 (❌)

Team members (1/3/10), API access, white-label (sold on the plan table, shown as **"soon"**) · Builder Bot / Analytics Bot ·
daily summary e-mail and "50% completed" WhatsApp alert (shown disabled) · WhatsApp Flows · per-segment features (§3.3) · multi-currency wallet ·
automated overage billing · proration on plan changes (an upgrade starts a new period; downgrade = cancel and re-subscribe) ·
the funnel uses accessible CSS bars rather than a Recharts `FunnelChart` (per-question charts use Recharts).
