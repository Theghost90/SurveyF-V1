# SurveyFlow V1 — decisions, spec corrections and open questions

This file lists every place where the build **departs from the spec or the design**, why, and what is still
**unverified or undecided**. Read §3 and §4 before going live. What is built and what is not, item by item with its size, priority, risks and the decisions behind it, is kept in [`BACKLOG.md`](BACKLOG.md).

Legend: ✅ done and tested here · ⚠️ built, but could not be verified against the real third-party service from the
build environment · ❌ not built in V1.

---

## 1. Spec vs. design: which won

| Topic | Spec (docx) | Design ("SurveyFlow Hero & Pricing") | Used |
|---|---|---|---|
| Plan prices | Starter 9,500 · Growth 29,000 · Business 75,000 FCFA | 14,500 · 39,000 · 95,000 (hero says "from 14,500") | **Design prices — owner decision (2026-10-15).** Changed in `packages/shared/src/plans.ts`; seed, tests and e2e updated. Non-FCFA prices are no longer typed in: they are these FCFA prices at a live exchange rate (§3.3, "Multi-currency money"). Annual = 10 × monthly (145,000 / 390,000 / 950,000). |
| "First proposal" | — | Hero **A** ("Ask → Hear → Know → Act") and Pricing **A** ("How many voices?") | Those two. |
| Hero CTA "Watch a survey in 60 seconds" | — | No video asset exists | Replaced with "See how it works" (anchor). |
| "Builder Bot & Analytics Bot", "Quick numbers on WhatsApp", "47 new answers on your WhatsApp" | Builder is a **web dashboard**; the only bot command is `START` | Marketed as features | **Removed from the copy** when this was written, because neither existed. **Update (2026-10-17): the Analytics Bot was built afterwards** (§3.5) and is now sold on Starter, Growth and Business (Explore sees it in the simulator). **The Builder Bot is still not built** and stays out of the copy. |
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

9. **(Superseded 2026-10-17, see 3.5: Explore has no trial clock.) Trial → "auto-downgrade to Starter if no payment method"** vs. Starter being a *paid* plan vs. the lifecycle
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
- **Security** (first pass; the sign-in and data-protection build of §3.7 and `docs/SECURITY.md` replaced and extended most of it): tokens AES-256-GCM encrypted at rest; the API never trusts
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
  `CAMPAY_WEBHOOK_KEY`, `PUBLIC_API_URL`, `WEB_ORIGIN`, `API_URL`, … See `.env.example` (the sign-in and data-protection set — `ENCRYPTION_KEYS`, `BLIND_INDEX_KEY`, `EMAIL_*`, `TURNSTILE_*`,
  `PUBLIC_WEB_URL`, `CLIENT_IP_HEADER` and the limits — is listed in `docs/SECURITY.md` §15.1).

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

### 3.4 Payments hardening (built 2026-10-16) — the structural choices

Goal and full register: `docs/PAYMENTS.md`. Decisions that are yours to confirm or overrule:

1. **A provider-verified success always wins over our own "failed"/"expired".** Both are our conclusions, not the provider's. Cost: a payment can turn `success` days after the customer saw "failed"; benefit: no customer is charged without a plan. The late window is **7 days** for polls and the job; a signed webhook is honoured at any age.
2. **New status `review`** instead of `failed` when money arrived but cannot be applied (underpaid, wrong currency, lower plan than active, activation error). It needs a person; there is no automatic refund and no automatic partial credit. Choose later whether a small underpayment (say < 5 %) should be credited automatically — I did not decide that for you.
3. **Only a push provider (Campay) is barred from failover after an ambiguous failure.** Hosted providers keep failing over, because the failed provider's checkout page is never shown to the customer. The price: after an ambiguous Campay failure the customer must wait (told not to pay again, 3 min block) instead of being silently moved to another provider.
4. **Expiry is never blind.** A payment expires only after the provider was asked once more (or was unreachable for 48 h).
5. **Reuse windows by method** (card 10 min, Mobile Money 90 s) and **at most 4 payments in flight** per customer. These numbers are judgement calls; they are constants at the top of `services/payments/service.ts`.
6. **A lower plan can no longer be bought while a higher one is active, through any route** (not only the upgrade button), and a payment that lands as a downgrade after an upgrade goes to `review`.
7. **Renewal reminders**: WhatsApp 3 days before the end and when overdue, plus an in-app banner. Mobile Money has no automatic debit, so *renewal is always the customer's action*; this is the only prompt they get.

### 3.5 Explore / Activate, WhatsApp-first onboarding, Analytics Bot (built 2026-10-17)

**Pricing model (cash-first).** *Explore* is free, has **no clock** and is capped by usage only: 1 live survey, 5 different people reached for the whole life of
the account, 25 messages. *Activate* (Starter / Growth / Business) removes the people cap. Annual billing is 11 months charged ("1 month free"). Not built, by
decision: founding-member pricing, a money-back guarantee, a time-limited trial (revisit once conversion data exists). A lapsed or cancelled paid plan returns to
Explore, never to a free Starter. `TRIAL_EXPIRY_POLICY` and `TRIAL_DAYS` are gone. Funnel milestones (`FunnelEvent`, once per owner) exist to measure conversion.
*Risk:* the 5-people cap is a guess; nothing measures it yet.

**Onboarding.** Two required steps: the customer's segment, then *Connect WhatsApp* (can be postponed with "I will do this later"). Anything that needs the number
(create or publish a survey, add or import contacts, top up, send) answers `409 whatsapp_not_connected`; the web app turns that into one shared "finish connecting
your WhatsApp Business number" dialog. The rest of the set-up lives in the dashboard's *Getting started* box. *Cost:* until Meta setup is done a newcomer cannot
build; the dashboard card and "do this later" soften it, but a long Meta verification is a real drop-off risk.

**Is connecting WhatsApp silent?** Not entirely, and it cannot be. With Embedded Signup the customer logs in to Facebook, picks or creates their WhatsApp Business
account, enters the number and confirms the code Meta sends to it, and approves the permissions; **they must also add a payment method to their WhatsApp
account** (Meta bills them directly). SurveyFlow then does the rest unattended: token exchange, webhook subscription, and the submission of the message
templates (now in the background in live mode; approval is asynchronous). Number registration (`/register` with a PIN) is *not* implemented and Embedded Signup
may need it: only a real run shows. None of this has been exercised against real Meta.

**Analytics Bot** (Starter, Growth, Business; Explore sees it in the builder preview and the simulator with example numbers). It speaks from SurveyFlow's own
number. The owner proves the phone with a one-time code (`LINK <code>`, 15 minutes, single use, up to 3 phones, `UNLINK`): the phone in the profile is never
trusted. Commands (FR/EN, any case or accent): STATS, RESULTS, DROP (alias PERQ), NONRESP, STARTED, COMPLETED, SURVEYS, MORE, HELP, MUTE / ALERTS ON. Names are shown with
**masked numbers**; complete numbers exist only in SurveyFlow (paged list and CSV, which defuses spreadsheet formulas). One shared formatter produces the replies, the
builder preview and the simulator; a test asserts every bot number equals the dashboard's. Corrections to the original design: STATS adds up (in progress is its own
row), opted-out people are excluded from every list, "consider making it optional" follows one rule everywhere.
*RESULTS* shows the top choice **with its share and count** (never the name alone), the average of a rating, the number of comments.
*Push alerts*: a milestone (100, 500, 1,000, 5,000, 10,000 completed) and a slowdown (no answer for 48 h on a survey with at least 10, once a week). Because the bot
is on SurveyFlow's number, an alert outside the owner's 24-hour window is an approved template **billed to SurveyFlow, not to the owner**: hence the free in-window
reply, the cap of 3 templates a day and 15 a month per owner, and the mute switch (typed, or in Settings). The `owner_alert` template is submitted to the platform
WABA in live mode; until Meta approves it only in-window alerts go out.

### 3.6 Navigation, responsive layout, sharing a test instance, sign-in (built 2026-10-18 to 2026-10-20)

**Navigation.** The menu bar of the public site and of the app is sticky at every width and never wraps. Below 640 px the public site shows logo, language switch, a short
"Explore free" button and a hamburger that opens a side menu; the app keeps its header plus a bottom tab bar (Home, Surveys, Contacts, Simulator where it exists).
**Settings is reachable only from the account menu**, and the phone tab bar has **no "More" sheet** (it duplicated the account menu; it was built first, then removed).
*Cost:* on a phone, Settings and Billing are two taps away (account button, then the item). Details and the width tiers: `surveyflow_design.md` §5 and §11.

**Landscape phones and other short screens.** A `short:` Tailwind variant (screen height 480 px or less) slims the bars, turns the tab bar into a thin horizontal one and keeps menus
inside the screen. It is a plugin variant on purpose: declaring it as a raw `theme.extend.screens` entry silently disables every `max-*` variant (Tailwind 3.4), and the
menu bars then stop fitting at 280 px with no error. **Support floor: 320 px wide** (WCAG reflow); **280 px (a folded phone) is covered by the sweep too.** French is tested
as well as English because its labels are longer. *Not covered:* real devices (the sweep uses Chromium at those sizes); the page screens are checked on the 30 listed device orientations, the menu bars at every width.

**Sharing a test instance** (`npm run share`, `docs/SHARE_DEMO.md`, `docs/TESTER_GUIDE.md`). It builds the app, starts it the way a server would and opens a free Cloudflare "quick
tunnel" that points **only at the website**; the API stays private on the computer. **Demo mode is forced whatever `.env` holds** (WhatsApp, payments and gifts are simulated, `SF_DEMO=1`),
so a tester can never send a real message or move real money. The demo account gets a random password (`--seed`). Docker publishes Postgres and Redis on this computer only.
*Risks to know:* the address changes every run; the computer must stay on and connected; anyone with the address can register (Explore: 1 live survey, 5 people), so share it
with the tester only; the tunnel is not a production setup.

**Sign-in.** E-mail and password, plus Google when `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `INTERNAL_API_SECRET` are set. Both were rebuilt by the security work in §3.7 (a confirmed
e-mail address, a Google ID token that the API verifies itself, sessions that can be revoked, an optional authenticator app). The earlier description of Google sign-in (a session minted for
any e-mail address on the website's word) no longer applies: that endpoint is gone.

### 3.7 Security build: sign-in, sessions, data protection (built 2026-10-20 to 2026-10-28)

Full reference, operations guide and the list of what is *not* covered: **`docs/SECURITY.md`**. Scope, as you set it: the 15 findings of the registration-and-login review **except finding 11 and finding 13**
(they are the matrix items DAT-02 and DAT-01) and the matrix items SEC-01 to SEC-15; SEC-16 to SEC-20 were added afterwards (§3.8). Where a finding and an item overlapped, it was built once: finding 6 is SEC-05, finding 9 is SEC-10, finding 4 is
SEC-06 + SEC-06b + SEC-08, finding 5 is SEC-04 + SEC-11. The e-mails and the audit log that finding 13 mentions are built, because SEC-01, 04, 06 and 08 need them.

**Built** (each ✅ except where §4 says otherwise): e-mail confirmation with single-use hashed links and a 24-hour purge of unconfirmed accounts · the same answer, in the same time, for a new and an existing address · one account per mailbox
(Gmail dots and `+tags` folded) · password reset and change · argon2id with a policy (10+ characters, common and breached passwords refused) · rising delays, a CAPTCHA and alert e-mails instead of lock-outs · new-device e-mails · sessions as database rows with a 15-minute
API token, a rotating refresh token with reuse detection and a 12-hour absolute life, "sign out everywhere", key ids for secret rotation · Google sign-in verified by the API, linked by Google's stable subject, never merged silently · authenticator-app two-factor with recovery codes ·
phone numbers masked in every list with a limited, logged reveal · exports and bulk deletes capped, e-mailed to the owner, audited and, when large, behind "confirm it is you" · an append-only audit log the owner can read · the visitor's real address taken only from the website's server with
the shared secret · a Content-Security-Policy with a per-request nonce and the other browser headers · an API proxy that refuses smuggled routes, oversized bodies and cross-site calls · participants' names and numbers encrypted with a key ring and a keyed index (`scripts/rotate-keys.mts`) ·
search terms kept out of logs · a test over every route that holds one owner out of another's data.

**Decisions taken from the matrix review (your approval):** SEC-08 (audit log) is a Must and is built · SEC-06 is split: e-mail alert and daily cap (Must) and the step-up confirmation (SEC-06b), both built · LEG-02, OPS-03, PAY-02 and LEG-04 are split or narrowed as proposed (these are
matrix changes: nothing in the code) · **launch means public, with real money**, so ADM-01 and ADM-02 (staff foundation, money console) stay Must and are **not built here**.

**Structural choices that are yours to confirm** (the reasoning is in SECURITY.md; every limit is an environment variable):
1. **An unconfirmed account can sign in and look around**; nothing that sends, pays, connects, exports or loads participants works until the address is confirmed. The alternative is "no sign-in until confirmed".
2. **Pre-hijacking is closed** since SEC-19 (§3.8): the confirmation page asks for the password chosen at sign-up, so a person who clicks a confirmation e-mail they did not ask for cannot confirm a stranger's account. The cost is one more field for everybody; `CONFIRM_REQUIRES_PASSWORD=false` removes it.
3. **No lock-outs.** Delays and a CAPTCHA only, because a lock-out lets a stranger stop a customer from signing in. With the CAPTCHA switched off a botnet can still try about one guess per address per minute.
4. **The authenticator app is optional**, and required only on the Business plan for large exports and bulk deletes. Google sign-in does not ask for it (Google's own protections apply).
5. **The thresholds are judgement calls**: confirmation from 50 rows (export) or 20 contacts (delete), 20 downloads and 50,000 rows a day, 300 revealed numbers a day, 15-minute confirmations. Tune them with real use.
6. **Numbers are masked; names and free-text answers are not**, but since SEC-20 (§3.8) one login can list at most 20,000 different participants a day and needs a recent confirmation past 1,000. Survey answers are stored unencrypted.
7. **Owner separation stays in application code**, guarded by a test over every route, not Postgres row-level security (a larger change; revisit before an admin console exists).
8. **Google Sheets auto-sync** needs a fresh confirmation to be switched on and pauses itself 30 days after the last one (SEC-20, §3.8).

**Found by the build's own review, and fixed** (all but the last have a test; details in SECURITY.md): a browser with a live session could reach the sign-in, token-renewal and Google routes through the website proxy by encoding the address (`%2F`, `%3F`, `..`) · recovery codes were hashed with a key derived from `JWT_SECRET`, so the documented, supposedly harmless rotation of that secret would have silently invalidated every owner's recovery codes (now a plain SHA-256 of an 80-bit code) · the confirmation e-mail greeted the recipient with the name typed at sign-up, which let a stranger make SurveyFlow's own sender deliver their words to a third person · after sign-in the browser could be sent to another site (`/\evil.example`) · sign-up, resend and forgot-password answered the same but not in the same time (the e-mail took longer to send for a real address) · sign-in limits could be multiplied by spelling an address differently · a refresh that rotated the token but whose answer was lost left the cookie stale.

**Found by the dependency audit, and fixed in separate commits (not on your list; each can be reverted):** `npm audit` first reported 22 advisories in production dependencies, the serious one being the website framework: **Next.js 14.2.35 had 25 advisories, one critical remote-code-execution flaw that affects Windows-hosted servers (CVE-2026-75604) — which is what `npm run share` from a Windows PC is.** The site now runs **Next.js 15.5.28 with React 19** (about 15 files changed for the asynchronous `cookies()`, `headers()` and route `params`, behaviour unchanged). `npm run share` still refuses to start on Windows **only when the installed Next.js is in the affected range**. The rest followed as SEC-17 (§3.8): `npm audit --omit=dev` now reports **0**.

**Not built:** finding 11 as such (DAT-02: encrypted disks and backups depend on the hosting; the application-level encryption of names and numbers, SEC-15, **is** built) · finding 13's account deletion and export are built since 2026-10-31 (DAT-01, §3.9); a
parked-reply and audit retention is built) · Postgres RLS · staff console, roles, staff two-factor (ADM-01 to ADM-06) · a breach-notification procedure.

### 3.8 SEC-16 to SEC-20, the dependency majors, the living backlog and the preflight (built 2026-10-28)

The rows you approved from the "rows I suggest" list (SEC-17 to SEC-20 built; PAY-13 counted in the matrix and **not** built), the SEC-16 upgrade, and the tooling asked for with them. Reference: `docs/SECURITY.md` §3.1, §8, §10.1, §18 and §19; the state of every row: `docs/BACKLOG.md`.

**Built** (each ✅ except where §4 says otherwise): **SEC-17**: zod 4, puppeteer 25 and Prisma 7, `overrides` for the last three advisories, and `npm run audit:gate` / `npm run release:check` (`npm audit --omit=dev` reports 0). zod 4 probes for `eval` when it builds its first schema and the website's Content-Security-Policy forbids eval: the browser run caught the resulting violations, so browsers get zod's plain parser (`packages/shared/src/zod-setup.ts`) and the policy stays strict · **SEC-18**: the general rate limit counts per verified session, with a ceiling per address ·
**SEC-19**: the confirmation page asks for the password chosen at sign-up · **SEC-20**: a cap on how many different participants one login lists in a day, and Google Sheets auto-sync that needs a fresh confirmation and pauses after 30 days · `docs/BACKLOG.md` with its checker (`npm run backlog:check`, part of `npm test`) ·
`scripts/preflight.mts` · tests for the website's API proxy (`apps/web/tests`).

**Structural choices that are yours to confirm:**
1. **Node 22.12 or newer is now required** (root `engines`, the Dockerfile, the Fly and Railway files; `npm run share` checks it). puppeteer 25 needs it, and the Prisma 7 tools too. Cost: anybody on Node 20 upgrades first.
2. **Prisma 7 changed how the API connects** (a driver adapter) and where the database address is read (`apps/api/prisma.config.ts`, which loads the one root `.env`). Its command line **refuses destructive commands from an AI agent**, so a person runs `npm run db:push` once after `npm ci`; production migrations use
   `prisma migrate deploy --config apps/api/prisma.config.ts`.
3. **The audit gate blocks a release on any high or critical advisory** unless it is written in `docs/audit-allowlist.json` with a reason and an end date; moderate and low are only listed (blocking on moderate too is noisier: the choice is one flag, `--level=moderate`).
4. **The backlog is one hand-written file with a checker**, updated in the same commit as the change. Its numbers are generated, never typed; against `origin/main` the checker refuses a vanished row, a Must item that leaves Must without a decision on record, and a change with no change-log entry.
5. **`preflight` is yours to run** for what only a real service or host can settle (e-mail, Turnstile, haveibeenpwned, a real CDN through `npm run share`, Windows and macOS). The build environment cannot reach those.
6. **The rate limits are per session**: 300 a minute per session and 3,000 a minute per address are guesses to tune with real traffic.
7. **The read caps** (1,000 different participants a day before a confirmation, 20,000 before a stop) and the 30 days of Sheets auto-sync between confirmations are judgement calls as well.

**Not built, counted:** PAY-13 (payout limits: a cap per account and per phone per day, and a hold on payouts for accounts only a few days old), a Must for any launch with real payouts: a wallet topped up by card and paid out to Mobile Money numbers is a known cash-out route for stolen cards (`docs/PAYMENTS.md`, "Chargebacks and the cash-out route").

### 3.9 DAT-01: the owner's download and deletion (built 2026-10-31)

Asked for on 2026-10-31 (D-10), which lifts D-05 for this row. Reference: `docs/SECURITY.md` §20; the state of the row: `docs/BACKLOG.md`.

**Built:** Settings → Your data: a whole-account download and a scheduled deletion; the freeze while it is scheduled; the archive of money records without personal data; the retention job doing the work once an hour. The backlog's containment, item by item: *a 30-day grace period* (30 days, cancellable, e-mailed) · *re-authentication* ("confirm it is you" for both, every time) · *keep minimal financial records* (amount, currency, status, provider, purpose, date, under a keyed pseudonym; nothing that names anyone) · *an expiring signed link* (**not built as a link, on purpose**: the file is built when asked and sent to the browser that asked, so there is nothing stored and nothing to forward; a link, even a short-lived one, is a thing to steal).

**Structural choices that are yours to confirm:**
1. **The 30 days against s.38(2).** The certified text says the controller "shall erase personal data **immediately** upon the express request" (subject to retention rules). A 30-day delay is a deliberate departure, chosen to protect owners from a hijacked session or a hasty click. What softens it: the account stops acting at once (surveys paused, nothing can be changed, nobody is messaged). What it does not change: the data sits for 30 days. **Ask counsel**; the number is one variable (`ACCOUNT_DELETION_GRACE_DAYS`, 1 to 90).
2. **Erasure is refused while money is unresolved**, instead of forfeiting it. Cost: an owner with a few leftover francs in the wallet cannot leave until it is spent (nothing in the product lets them withdraw it: that is the wallet's own rule, `docs/PAYMENTS.md`). The alternative (forfeit or refund on exit) is a money decision, not mine.
3. **10 years for money records** is the usual commercial-accounts period, **not checked against Cameroonian law**; it is a default for counsel (`FINANCIAL_RETENTION_YEARS`).
4. **The account download is not held to the daily rows cap** (found and fixed before shipping: it would have locked out any owner with more people than the cap, for good). Costs: a thief who passes the confirmation can take everything in one go; what limits that is the confirmation, 3 a day, the e-mail and the trail. The cap still binds every other download that day.
5. **Revoking every other session** on request and **the 423 freeze** are one more read of the database on every non-GET call (one indexed lookup by id).
6. **Pausing the surveys** on request and **not resuming** them on cancel: an owner who cancels resumes by hand, so a hijacker who schedules and then cancels cannot restart anything.
7. **A participant cannot use this.** Their rights run against the owner (the controller of their data); there is no channel for it in the product yet.

**Not built:** a staff queue for requests (ADM-02) · erasure from backups (they age out after `BACKUP_KEEP_DAYS`, §3.10) · the participant-facing request channel.

### 3.10 DAT-02: encrypted backups, the restore test and the host's disk (built 2026-10-31)

Asked for on 2026-10-31 (D-10), which lifts D-05 for this row. Reference: `docs/SECURITY.md` §21, `docs/BACKUP_RESTORE.md`; the state of the row: `docs/BACKLOG.md`.

**Built:** the backup tooling and its tests. The backlog's containment, item by item: *managed encryption* (the one half a repository can hold is the backup: sealed as it is written; the disk is the host's, below) · *restore tests* (a weekly scratch restore with row counts and a participant decryption, a recovery command, and a preflight check that fails a backup that was never restored) · the risk it names, *a lost key* (the key is for two places away from the server; a test shows that the key you hold opens the backups you hold; a key can be replaced without losing old backups).

**Structural choices that are yours to confirm:**
1. **The row stays "built, check open" and not "built".** Finding 11 was "plain text at rest and in backups". I closed the backups; the disk at the host I cannot close or even see. If you prefer, the row can be split in two (the code, built; the host's disk, your action) the way SEC-06 and LEG-02 were: I did not do it without your say, since the split changes the Must count.
2. **Our own scripts, not a backup service.** Chosen because the application's whole security claim (§11) depends on keys the host never sees, and a provider's backup copies the same data under the provider's key. The cost is something to schedule, monitor and restore-test yourself. Your database host's own point-in-time backups are still worth switching on: this is the second, independent copy.
3. **A separate key from `ENCRYPTION_KEYS`.** A leak of one then does not open both. The cost is a second key to keep in two places; recovery also needs `ENCRYPTION_KEYS` and `BLIND_INDEX_KEY`.
4. **Authenticated chunks of our own format (`SFBK1`), not `openssl enc` or `gpg`.** `openssl enc` has no authentication (a damaged backup would "open" into garbage) and `gpg` is not on every computer. The cost is that we own a small format: it is about 100 lines of code (`scripts/lib/sealed-file.mjs`), covered by tests including tampering, truncation and reordering, and it has had **no outside review**: have one before it protects data you cannot afford to lose, or swap it for `age` or `gpg` (the manifest and the restore test do not depend on the format).
5. **30 days kept, newest three never pruned**: `BACKUP_KEEP_DAYS`. Erased data therefore survives in backups up to 30 days, which counsel should also hear about together with the 30-day grace (§3.9).

**Not built:** disk encryption (yours: provider's documentation, then `HOST_DISK_ENCRYPTION`) · the job that runs the backup (a cron line or task you create: the repository has no scheduler for the operator's machine) · copying the sealed files off the machine · re-applying erasures after a recovery.

### 3.11 WA-03: the category of a survey's invitation, the cost warning and Meta's re-categorisation (built 2026-10-31)

Asked for on 2026-10-31 (D-10). Reference: `packages/shared/src/message-category.ts`, `docs/BACKLOG.md` (the row and its open check).

**Facts I could and could not establish.** Meta's documentation says each template is authentication, marketing or utility and that the category affects pricing; its categorisation page names a feedback survey with promotional content as a mixed-content risk; its reference of the `template_category_update` webhook has two shapes (a completed change with `previous_category` and `new_category`, an announced one with `correct_category`) and does not always carry the template's language. **That a feedback request is utility only when tied to a specific order or interaction I found only in third-party summaries, not on Meta's own page**; I could read search summaries, not the pages themselves. The rules below are therefore a default that errs towards the safe side, and Meta's decision always wins.

**Built, against the backlog's containment** (*default to marketing when unsure, wording rules, a cost warning*):
- **Marketing unless it qualifies.** Utility needs all of: the owner states the survey follows something the person did with the business (a purchase, a booking, a visit) · no reward or prize is attached (any type) · nothing in the title, description, thank-you or the questions and options reads as a promotion (an English and French word list, whole words, accents ignored; a percentage counts only when followed by off, discount or remise). The reasons are shown in plain words, in the builder as the owner writes and again at the send; the owner **cannot** force utility.
- **Two invitation templates.** The utility one now names what it follows up ("Following your recent order, visit or booking with ..."); the general wording that was the invitation until now moved to a new marketing one (`survey_invitation_marketing`). Templates per account: 14 to 16. A test keeps promotional wording out of every utility template that asks the person to do something.
- **The cost warning cannot be skipped.** A marketing send is refused (409 `marketing_cost_unacknowledged`) unless the owner has ticked that they accept the cost, **every time**; the send button waits for the tick; the warning shows how many people and why. Every send is in the audit trail with its category, its reasons and whether a cost was accepted.
- **Re-categorisation.** `template_category_update` (completed and announced) is stored; a move to marketing e-mails the owner once (also in advance, when Meta gives notice); a utility survey on an account whose utility template is now marketing counts as marketing; **an invitation queued as utility is held as failed (`category_changed`) rather than sent at a rate nobody accepted**, and goes out after a new send with the tick. Notices for another WhatsApp Business account, or for an unknown template, change nothing.

**Structural choices that are yours to confirm:**
1. **Every marketing send now needs an explicit acknowledgement, and marketing is the default, so every send does** until an owner declares and qualifies a survey for utility. That is a change to how existing integrations call `/send` (20 call sites in the tests, two browser scripts). The alternative, one acknowledgement per survey, asks less and protects less: a re-categorisation between two sends of the same survey would pass unseen.
2. **The declaration is a self-declaration.** An owner can tick it for a promotion. The reward and wording rules stop the obvious cases; nothing can see what is really in the list of people. If the owner lies, Meta's own review and the template's quality rating are the backstop, which is exactly the risk this row exists to reduce, not remove.
3. **A reward means marketing.** That makes most surveys with a gift marketing. It is the safe reading of "mixed content"; it also means a "no gifts" reward decision (`docs/PUBLIC_PROFILE.md`) would let more surveys be utility.
4. **No prices in the product.** The rates are Meta's, differ by country and change, and I could not verify them; the warning says "higher rate" and points to the owner's WhatsApp Business billing. A configurable estimate is easy to add if you give me the numbers and want to keep them current.
5. **Reminders are unchanged**: they were declared marketing on your decision and still go out without a per-send warning; they are single and automatic or manual with a button the owner presses. Say if the manual reminder button should carry the same acknowledgement.
6. **The gift notice stays utility** and is exempt from the wording rule on purpose: it confirms a delivery. Meta may still re-categorise it; the same handler will store that, but no survey logic depends on it.
7. **A job queued before this change has no category and is sent as marketing** (the safe direction), without an acknowledgement from the owner: the only jobs this can touch are invitations still waiting at the moment of the upgrade.

**Not built / not verified:** anything against the real Meta (WA-01 is yours to run: whether the two wordings are approved in the categories they declare and whether either is re-categorised) · ticking `template_category_update` in the app's webhook settings (`docs/META_CHECK.md`) · prices.

## 4. What is verified and what is not

**Verified in this environment** (real Postgres + Redis + headless Chromium):
655 automated tests (84 shared + 492 API in 30 files + 22 website + 57 script tests, last run 2026-10-31, after DAT-01, DAT-02 and WA-03: the account download and deletion, the encrypted backups and their restore test, the message category and the cost acknowledgement: state machine, signed + duplicate + concurrent webhooks, abandonment/resume, STOP, analytics, gifts, the gift wallet (guarded debit under parallel completions, refunds, release/retry double-clicks, deletion guards),
plan limits, payments incl. forged/under-paid/duplicate webhooks, failover and fee ranking, lifecycle, **payment hardening** (a lost webhook is found by the reconciliation job, a late success is credited, an underpayment goes to review, an unconfirmed push start never reaches a second provider, eight simultaneous clicks start one payment — `docs/PAYMENTS.md`), Excel/PDF/Sheets with Google stubbed, **automatic reminders** (every rule to the minute on a simulated clock, once-only under two parallel workers,
switches, quota, opt-out, deadlines), **geolocation** (country → currency/prices/phone format, lock after first payment, unknown/unsupported → FCFA), **receipts** (only for delivered gifts, forged/tampered tokens, masked phone, no fee, escaped text) the segment gate, **live exchange rates** (cache, single flight, stale limit, bad-jump rejection, garbage from the source), **multi-currency** plans / wallet / gifts (naira and shillings, limits, card-only, payout conversion and pinning, outage behaviour, refunds, currency lock), **PSP fee ranking** with the documented fees,
**CamerPay** (request shape, signed webhooks: forged / tampered / under-paid / replayed), **Explore / Activate** (people cap, 25-message cap, lapse back to Explore, 11-month annual, funnel events), **the Analytics Bot** (owner linking with one-time codes, every command in FR/EN, masked numbers, numbers equal to the dashboard, RESULTS, milestone and slowdown alerts, daily and monthly template caps, mute), **the API lockdown** (which paths are public, traversal attempts) and **manual-reminder gating**, and the **sign-in and data-protection build of §3.7** — sign-up and enumeration answers, confirmation links, the three login counters, sessions and refresh rotation, password reset, Google sign-in with a stubbed key set, the authenticator app, "confirm it is you", masking and reveal, export and bulk-delete controls, the key ring and its rotation script, the audit trail, production boot refusals, log hygiene and a cross-owner test of every route: `docs/SECURITY.md` §16),
a 29-step real-browser end-to-end run (register → required segment step → onboarding → builder incl. the Timing & reminders card → publish → send → simulated participant → analytics → PDF/Excel download → mock checkout → settings
(Currency read-only, no provider/country picker) → an unreadable API response no longer white-screens the app → geolocated visitors: unknown/US see FCFA, Nigerian sees NGN prices and a +234 form and signs up as "Nigeria (NGN)" → FR/EN → mobile widths), a 6-step Kenyan-owner run (`scripts/e2e-currency.mjs`: pricing in shillings with the rate note → sign-up → plan paid by card in KES → wallet and gift limits in KES → French), run with the **API lockdown switched on** (the browser tests go through the real secret-carrying proxy), an 8-step payments run (`scripts/e2e-payments.mjs`: still-waiting is never "failed", payments in progress, review wording, renewal banner, "do not pay again"), a 12-step wallet run
(`scripts/e2e-wallet.mjs`: empty wallet → warnings → participant finishes unpaid → top-up → release → delivered with a template notice **and a receipt that opens a real PDF, while a tampered link 404s** → FR → mobile), an Analytics Bot browser run (`scripts/e2e-bot.mjs`: Explore sees only a preview, a paid plan links a phone with a one-time code, the simulator's Owner mode answers STATS / RESULTS / DROP with numbers equal to the Analytics page, alerts switch, "haven't started" list and CSV), a responsive run (`scripts/e2e-responsive.mjs`: 17 app screens, the Security tab included, at 320 to 1920 px, the public and sign-in screens at 12 widths, both menus; passed in full 2026-10-28), a landscape / short-screen run (`scripts/e2e-landscape.mjs`: both menu bars at 146 widths from 280 to 1440 px and the public and app screens on 30 device orientations, in English and French; §3.6), a **20-step security run** (`scripts/e2e-security.mjs`, with the API token set to 30 seconds so that the website's silent renewal is exercised throughout: sign-up, confirmation link, throttling countdown, password reset, authenticator app and recovery codes, sessions, "confirm it is you", the activity log, the proxy's refusals, sign-out everywhere, **zero Content-Security-Policy violations**), **all of these browser runs were repeated on the final stack: the Next.js 15.5.28 production build with zod 4, Prisma 7 and puppeteer 25** (SECURITY.md §16, §18), all eleven DB migrations applied
from scratch (no drift against the schema on Prisma 7; the `CHECK (balance >= 0)` rejects an overdraw), and the production bundles. Several tests were
mutation-checked (disabling the dedupe, lock, signature check, amount check, the wallet's balance guard, the release/retry
compare-and-set, the ledger-based refund, the reminder once-only claim, the switch check, the "delivered gifts only" receipt rule, the receipt signature check, the segment gate, the send worker's oldest-first ordering, the manual-reminder window check, the lockdown gate and its public-path pattern, the FX bad-jump and staleness rules, the payout conversion, the card-only rule, the wallet-currency guard or the CamerPay signature check makes the matching test fail — one wallet test and one reminder test were first found vacuous this way and fixed).
One real bug was found by the full-suite run and fixed: `UPDATE … RETURNING` does not keep the claim query's `ORDER BY`, so a worker that claimed a reminder and its closing note in one batch could send the note first; the worker now processes claimed jobs oldest-first (test forces the adversarial row order).
A second real bug came out of the browser run and was fixed: a *successful* API response whose body was cut off was parsed as `{}`, cached as the account, and crashed the whole app ("Application error") on `account.user.…`; `api()` now treats an unreadable success as a network failure (regression step in the e2e).
The browser console check ignores one known artefact: Next's `Failed to fetch RSC payload … Falling back to browser navigation` (and next-auth's matching `CLIENT_FETCH_ERROR`) printed when the test's hard `page.goto()` aborts an in-flight link prefetch
(reproduced in isolation as `net::ERR_ABORTED`); any other console error or 5xx still fails the run.
**Three first-run failures were found by following the README to the letter** (`cp .env.example .env`, `npm run dev`, then sign in and sign up in a browser), none of which any test had seen because no test read the example file: the API refused to start (`EMAIL_PROVIDER` and `WHATSAPP_PLATFORM_PHONE` ship blank and a blank was read as an invalid value); with that fixed, the confirmation e-mail's link had no address (a blank `PUBLIC_WEB_URL` was an empty string, not "use the first `WEB_ORIGIN`"), so the demo mailbox showed no button; and signing in answered 500 (a blank `NEXTAUTH_SECRET`: the website cannot sign a cookie with it). The first two are one bug with one rule at the boundary (a blank setting is a setting that is not there; `withoutBlanks`), the third a development-only fallback in `apps/web/next.config.mjs` (never in production). `tests/env-example.test.ts` and `apps/web/tests/dev-secret.test.ts` fail without the fixes; the browser flows (sign in as the seeded owner, sign up, confirm, sign in again) were then repeated with the untouched example file. A side effect worth knowing: a blank `REQUIRE_2FA_PLANS` is now the default `business` (`SECURITY.md` section 15.1).
Three flaky tests were found by repeating the suite and fixed; none was a product bug. (1) The two receipt tests looked for `fee`, `frais` and `525` in the whole page, and the receipt number is the tail of a random id: about one run in 4,000 it spells "FEE" (it did, once). They now read the page without the number and the provider's reference (`receiptWords`, with a test that feeds it a number spelling "FEE" and a reference holding "525"). (2) The funnel test did not wait for the best-effort "paid" event; it waits now. (3) Once in four full runs the reset between tests (`TRUNCATE`) was ended by Postgres as the victim of a deadlock, most likely with a best-effort write the previous test had left running (the "paid" event, an owner notice). **I could not reproduce it** (14 runs of that file alone: none), so the cause is a hypothesis; the reset now runs again on that one error, up to five times (`retryOnDeadlock`, unit-tested), which is the remedy Postgres documents. Production has no `TRUNCATE`: nothing changes there.
**Geolocation was exercised by sending the CDN header from the test browser**, not behind a real CDN. A second pass on 2026-10-28 (`docs/SECURITY.md` §19) ran what could be run against the real world and recorded the rest in the table below; `scripts/preflight.mts` repeats it on your computer.

**Written from documentation but NOT exercised against the real service** — the build environment has no credentials and
its network policy blocks these hosts. Treat each as "needs a sandbox pass":

| Area | Risk |
|---|---|
| Meta Cloud API client, Embedded Signup flow, template submission/approval, status webhooks | Payload shapes follow Meta's public docs; never sent to Meta. **Runnable check: `scripts/meta-check.mts` (`docs/META_CHECK.md`) — not yet run by the owner against a real Meta app** (the build environment cannot reach Meta). Tech Provider status (business verification + app review) and the Embedded Signup popup cannot be scripted. |
| Flutterwave v3 | Endpoints confirmed by documentation search; not called. |
| Notch Pay, CinetPay | Init/verify endpoints confirmed by documentation search; **webhook signature schemes are unconfirmed** (safe default: bad signature ⇒ rejected; the status poll still activates paid subscriptions). |
| **Campay, PayUnit** | **Lowest confidence**: paths/fields written from memory (PayUnit's endpoint paths and Campay's airtime endpoint especially). Do not enable without sandbox verification. Campay's collect is a *push*: the "maybe sent" rules (`docs/PAYMENTS.md` C3) assume its timeouts behave like any HTTP timeout, which only a sandbox can confirm. |
| Campay airtime/MoMo gifts | The spec says Campay can send airtime; the endpoint used is unverified. **Higher stakes now: owners' prepaid money is what pays through it.** |
| Gift fee, wallet legality, treasury float | Not code questions — see §3.1 items 1–3. |
| Analytics Bot over real WhatsApp | The owner linking (`LINK <code>` sent from the owner's own phone), the command replies and the `owner_alert` template were exercised only through the simulator's Owner mode and the mock gateway. The template has not been submitted to Meta, and until Meta approves it only in-window alerts go out (§3.5). Alerts outside the 24 h window are billed to SurveyFlow, so watch the first real invoice. |
| Reminder / closing-note templates and the receipt URL button | New templates (`survey_nudge`, `survey_deadline_note`, `survey_progress_saved[_deadline]`, `survey_gift_notice` with a URL button) have never been submitted to Meta; the URL-button payload follows Meta's documented component shape. Meta may re-categorise the reminders as marketing (§3 item 3). Inside the 24 h window the sent-notice is an interactive `cta_url` message (button + link, no raw URL in the text), written from Meta's documentation and never sent to Meta; outside it, the template's URL button. |
| NGN / KES / GHS / USD / EUR settlement | Prices are live conversions now (not placeholders); that each PSP can charge in these currencies is the owner's statement, not something tested (see "Provider currencies"). |
| **CamerPay** | Adapter written from public documentation pages; the host was unreachable from the build environment, so no request was ever sent. Initiate path/fields, the webhook signing string and field names must be confirmed in the sandbox/dashboard (the pages disagree on `callback_url` vs `merchant_callback_url`); there is no known status endpoint, so settlement relies on the webhook (the reconciliation job only re-reads the stored signed outcome). |
| Live exchange-rate source | `open.er-api.com` was not reachable from the build environment either: the service is exercised against a stub with the documented response shape (and the browser runs against `scripts/fx-stub.mjs`). Check one real fetch before launch. |
| Provider currencies | The owner states the providers accept XAF, XOF, ZAR, GHS, KES, NGN, UGX, USD, GBP and EUR (EUR confirmed 2026-10-15); this is taken as given and never tested against a provider account. |
| Provider fees | Taken from the owner's contract-fee document, not from the providers' live pricing pages (not reachable). |
| Google OAuth + Sheets | Implemented on plain REST; exercised only with Google stubbed. |
| **E-mail providers** (SMTP, Resend, Brevo) | The SMTP adapter was exercised against a **local SMTP server** and the Resend and Brevo adapters against a replaced `fetch` (message shape, credentials, failure handling); **no real provider was ever contacted** (the provider hosts are blocked here, and it needs your key and sender domain). Deliverability, SPF/DKIM/DMARC and the sender domain are untested and are a domain setting, not code. Production refuses to start with the mock provider. **Runnable check: `preflight --only mail --domain <yours> --mail-to <you>`** (DNS records and one real message). |
| **Cloudflare Turnstile**, **haveibeenpwned** | The widget (under the Content-Security-Policy), the server-side verification and the breach check follow the services' documentation and were never run against them: both hosts are blocked here, and both production checks **fail open** when the host is unreachable. Their pass paths were run against fakes (`preflight --fake-services`: a test of the script only). **Runnable check: `preflight --only breach,captcha`** on your computer. |
| **Google's key set and a real ID token** | **Google's real key set was fetched and five forged tokens were refused by the production verifier against it** (`preflight --only google`). A genuine token needs one real sign-in with your Google client id. |
| **A real CDN header and https** | **Rehearsed behind a local TLS proxy that sets Cloudflare's headers** (HSTS, `__Host-` and `__Secure-` cookies, a fresh CSP nonce, the audit trail recording the proxy's address, a misconfigured site detected): `docs/SECURITY.md` §19. Not a real CDN. Sent straight to the origin, a forged `cf-connecting-ip` is believed: the origin must accept traffic only from the CDN. On your PC `npm run share` is a real Cloudflare edge: `preflight --only headers --url <its address>`. |
| `@node-rs/argon2` off Linux | **Interoperates with the reference C implementation in both directions** (`preflight --only argon2`). The lockfile carries the binaries for Windows, macOS and Linux; the Windows and macOS ones were downloaded, their integrity matches the lock and their headers read as PE and Mach-O. Never executed there. |
| The Windows fix of Next.js (SEC-16) | The installed code refuses all 9 hostile cache lookups under Windows path rules (`preflight --only next`; it fails on 15.5.23). Not run on a Windows host. |
| Puppeteer on Docker/Fly/Railway | Works here with the bundled Chromium; the Dockerfile installs `chromium` but has not been built (no Docker daemon). |

## 5. Not built in V1 (❌)

Team members (1/3/10), API access, white-label (sold on the plan table, shown as **"soon"**) · Builder Bot (the Analytics Bot **is** built, §3.5) ·
daily summary e-mail and "50% completed" WhatsApp alert (shown disabled) · WhatsApp Flows · per-segment features (§3.3) · a wallet holding more than one currency (the wallet is fixed to one currency by the first top-up, §3.3) ·
automated overage billing · proration on plan changes (an upgrade starts a new period; downgrade = cancel and re-subscribe) ·
the funnel uses accessible CSS bars rather than a Recharts `FunnelChart` (per-question charts use Recharts).
Security (§3.7, `docs/SECURITY.md` §12): **the host's disk encryption** (DAT-02's host half) · **participants' own requests to the owner** (no channel yet) · Postgres row-level security · a staff console, roles and staff two-factor (ADM-01 to ADM-06) · masking of names and encryption of survey answers ·
payout limits per account and per phone (PAY-13, counted in the backlog, not built) · a breach-notification procedure. The full list, with sizes, priorities and risks: [`BACKLOG.md`](BACKLOG.md).
